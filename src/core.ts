import * as vscode from 'vscode';
import * as chokidar from 'chokidar';
import * as fs from 'fs';
import * as path from 'path';
const fsp = fs.promises;

export interface IFileObj {
  path: string;
  logPath: string;
  stats: fs.Stats;
  lastPosition: number;
  lock: boolean;
  isEventPending: boolean;
  fileHandler?: fs.promises.FileHandle;
}

export interface ICoreCtx {
  windowName: string;
  appDataCodeDir: string;
  logsDir: string;
  cleanLogOutputChannel: vscode.OutputChannel;
}

type TFilesMap = Map<string, IFileObj>;

export interface IChokidarWatcherController {
  chokidarWatcher: chokidar.FSWatcher;
  /**
   * Start listening to file changes and activating log cleaning
   * @returns Promise<void> return a promise that resolve when the watcher is ready
   */
  start: () => Promise<void>;
  /**
   * Stop listening to file changes and disabling log cleaning
   * - freeing resources usage
   * @returns Promise<void> return a promise that resolve when close() closing action finish which is async.
   */
  stop: () => Promise<void>;
  /**
   * Wether the listening and log cleaning is running or not
   * @returns boolean (is running)
   */
  isRunning: () => boolean;
}

function waitAsync(timeout: number): Promise<NodeJS.Timeout> {
  return new Promise<NodeJS.Timeout>((resolve, reject) => {
    const handler = setTimeout(() => {
      resolve(handler);
    }, timeout);
  });
}

export function getApplicationDataCodeDir(
  context: vscode.ExtensionContext
): string {
  let dir: string = context.globalStorageUri.path;
  const stopConditionDirNames = ['Code', '/'];
  while (!stopConditionDirNames.includes(path.basename(dir))) {
    dir = path.dirname(dir);
  }
  return dir;
}

export function getWindowName(context: vscode.ExtensionContext): string | null {
  const matchResult = context.logUri.path.match('Code/logs/.*?/(.*?)/');
  if (matchResult) {
    return matchResult[1];
  }
  return null;
}

const terminalEscapeCommandsRegex = /\x1b\[.{0,15}?m/g;
function cleanColors(log: string) {
  return log.replace(terminalEscapeCommandsRegex, '');
}

const transformers = [cleanColors];

export function cleanLog(log: string) {
  let output = log;
  transformers.forEach((transformer) => {
    output = transformer(output);
  });
  return output;
}

export async function readAndTransformTillTheEnd(
  fileObj: IFileObj,
  fileHandler: fs.promises.FileHandle
) {
  const bufferSize = 131072; // ~128kb following gnu cpy buffer
  const buffer = Buffer.alloc(bufferSize);
  let readData = '';
  let transformed = '';
  let readPosition = fileObj.lastPosition;
  let readResult;
  let totalReadSize = 0;

  let bufferData;

  while (
    (readResult = await fileHandler.read(buffer, 0, bufferSize, readPosition))
      .bytesRead
  ) {
    readPosition += readResult.bytesRead;
    totalReadSize += readResult.bytesRead;

    bufferData = buffer.toString('utf8', 0, readResult.bytesRead);

    // transformed += bufferData.replace(/\[.*?\]\s/g, '');
    transformed += cleanLog(bufferData); // TODO: transformers should be capable of working on chunks (use iteration transformer. That do the matching character to character) [chunks jointers, two chunks at the time, managing a limited size of regex. Otherwise the whole thing would need to go in two phases. first scan if in same chunk immediately transform. Otherwise if multiple chunks either go back and transform. Or finish all and do a second pass. Going back i guess is a great approach !!!!]
    readData += bufferData;
  }

  return {
    readData,
    transformed,
    totalReadSize,
    readPosition,
  };
}
/**
 * Function that
 * process log file changes, that are caught by chokidar
 *
 * @param fileObj
 * @returns
 */
async function processChange(fileObj: IFileObj, ctx: ICoreCtx): Promise<void> {
  const fileHandler = await fsp.open(fileObj.path, 'r+');
  fileObj.fileHandler = fileHandler;

  const { readData, transformed, totalReadSize, readPosition } =
    await readAndTransformTillTheEnd(fileObj, fileHandler);

  if (totalReadSize === 0) {
    await fileHandler.close();
    fileObj.fileHandler = undefined;
    return;
  }

  const transformedBuffer = Buffer.from(transformed);
  const lastPosition = fileObj.lastPosition;
  fileObj.lastPosition = lastPosition + transformedBuffer.byteLength;

  // Replace part (trunc, write) only if there was a cleaning and transformation
  if (transformed !== readData) {
    ctx.cleanLogOutputChannel.appendLine(
      `🔥 ::::::::::::::: CleanLog 🔥 :::::::::: >`
    );
    ctx.cleanLogOutputChannel.appendLine(
      `:::::::: ❗ ${fileObj.logPath} ❗ :::👉`
    );
    ctx.cleanLogOutputChannel.append(transformed);
    ctx.cleanLogOutputChannel.appendLine(
      `🔥 <::::::::::::::::::::::::::::::::::::::::> 🔥`
    );
    ctx.cleanLogOutputChannel.appendLine('');

    await waitAsync(500);

    await fileHandler.truncate(lastPosition);

    await fileHandler.write(
      transformedBuffer,
      0,
      transformedBuffer.byteLength,
      lastPosition
    );
  }

  await fileHandler.close(); // close the file
  fileObj.fileHandler = undefined;
}

/**
 *
 *
 *  Chokidar listen
 *
 *
 *
 */

export function fileHandlerFactory(filesMap: TFilesMap, ctx: ICoreCtx) {
  const fileHandler = async (filePath: string, stats: fs.Stats) => {
    let fileObj = filesMap.get(filePath);

    if (!fileObj) {
      fileObj = {
        path: filePath,
        logPath: filePath.replace(/^.*?\/Code\/logs\//, ''),
        stats,
        lastPosition: 0,
        lock: false,
        isEventPending: false,
      };
      filesMap.set(filePath, fileObj);
    } else {
      fileObj.stats = stats;
    }

    if (fileObj.lock) {
      fileObj.isEventPending = true;
      return;
    }

    fileObj.lock = true;

    await processChange(fileObj, ctx);

    while (fileObj.isEventPending) {
      fileObj.isEventPending = false;
      await processChange(fileObj, ctx);
    }

    fileObj.lock = false;
  };

  return fileHandler;
}

export function getCleanLogWatcherController(
  ctx: ICoreCtx
): IChokidarWatcherController {
  let isRunning = false;
  let isWatcherReady = false;
  const filesMap = new Map<string, IFileObj>();

  const fileHandler = fileHandlerFactory(filesMap, ctx);

  const watchingPattern = `${ctx.logsDir}/**/${ctx.windowName}/**/*.log`;
  // const watchingPattern = ctx.logsDir + '/**/Git.log';

  const chokidarWatcher = new chokidar.FSWatcher({
    persistent: true,
    useFsEvents: false,
    usePolling: true,
    // ignoreInitial: true,
  });

  return {
    chokidarWatcher,
    isRunning() {
      return isRunning;
    },
    async start() {
      if (!isRunning) {
        return new Promise<void>((resolve) => {
          chokidarWatcher.add(watchingPattern);
          chokidarWatcher.on('add', fileHandler);
          chokidarWatcher.on('change', fileHandler);
          if (!isWatcherReady) {
            chokidarWatcher.on('ready', () => {
              resolve();
              isRunning = true;
              isWatcherReady = true;
            });
          } else {
            isRunning = true;
            resolve();
          }
        });
      }
    },
    async stop() {
      if (isRunning) {
        // Closing all chokidar filesystem listeners
        await chokidarWatcher.close();
        // Closing any logs open file handlers
        const closingLogFilesPromises: Promise<void>[] = [];
        filesMap.forEach((fileObj) => {
          if (fileObj.fileHandler) {
            closingLogFilesPromises.push(fileObj.fileHandler.close());
          }
        });
        await Promise.allSettled(closingLogFilesPromises);
        isRunning = false;
        // chokidarWatcher.removeAllListeners('add');
        // chokidarWatcher.removeAllListeners('change');
        // chokidarWatcher.off('add', fileHandler);
        // chokidarWatcher.off('change', fileHandler);
        // chokidarWatcher.removeListener();
      }
    },
  };
}
