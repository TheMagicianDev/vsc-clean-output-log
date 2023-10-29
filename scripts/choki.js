/**
 * A script part of the initial tinkering in 2022 (1yr and half ago)
 */

const chokidar = require('chokidar');
const fs = require('fs');
const fsp = fs.promises;

const logsDir =
  '/Users/mohamedlamineallal/Library/Application Support/Code/logs';

const filesMap = new Map();

let lock = false;

const terminalEscapeCommandsRegex = /\x1b\[.{0,15}?m/g;
function cleanColors(log) {
  return log.replace(terminalEscapeCommandsRegex, '');
}

const transformers = [cleanColors];
function cleanLog(log) {
  let output = log;
  transformers.forEach((transformer) => {
    output = transformer(output);
  });
  return output;
}

async function processChange(fileRef, fileObj) {
  console.log('Process >');
  const { path: filePath, stats } = fileRef.current;

  const fileHandler = await fsp.open(filePath, 'r+');

  console.log({
    lastPosition: fileObj.lastPosition,
  });

  const newFileSize = stats.size;

  async function readAndTransformTillTheEnd() {
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
      console.log({
        readResult,
        totalReadSize,
        readPosition,
      });

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

  // let dataLength;
  // if (newFileSize > fileObj.lastFileSize) {
  //   dataLength = newFileSize - fileObj.lastFileSize;
  // } else {
  //   dataLength = undefined;
  // }

  const { readData, transformed, totalReadSize, readPosition } =
    await readAndTransformTillTheEnd();

  if (totalReadSize === 0) {
    await fileHandler.close();
    return;
  }

  const transformedBuffer = Buffer.from(transformed);
  const lastPosition = fileObj.lastPosition;
  fileObj.lastPosition = lastPosition + transformedBuffer.byteLength;

  console.log('Before truncate ============');
  console.log({
    lastPosition,
    totalReadSize,
    readPosition,
  });
  await fileHandler.truncate(lastPosition);
  console.log('after trunc');
  const b = await fsp.readFile(filePath);
  console.log(b.byteLength);
  console.log(b.toString());
  await fileHandler.write(
    transformedBuffer,
    0,
    transformedBuffer.byteLength,
    lastPosition
  );
  await fileHandler.close(); // close the file
  console.log('after write');
  console.log((await fsp.readFile(filePath)).byteLength);

  console.log('Read data ::::::::::::');
  console.log(readData);

  console.log('Transformed to :::::::::::::');
  console.log(transformed);
}

const fileRef = {
  current: {
    path: undefined,
    stats: undefined,
  },
};
let isEventPending = false;

/**
 *
 *
 *  Chokidar listen
 *
 *
 *
 */

const fileHandler = async (filePath, stats) => {
  // if (!filePath.toLowerCase().includes('shared')) {
  //   return;
  // }

  // console.log('shared ////////');

  let fileObj = filesMap.get(filePath);

  if (!fileObj) {
    fileObj = {
      lastPosition: 0,
      lock: false,
      isEventPending: false,
    };
    filesMap.set(filePath, fileObj);
  }

  console.log('Chokidar: Change ==========');
  console.log(filePath);
  console.log(stats);

  if (fileObj.lock) {
    fileObj.isEventPending = true;
    console.log('is locked !<');
    return;
  }

  console.log('lock >');
  fileObj.lock = true;

  fileRef.current = {
    path: filePath,
    stats,
  };

  await processChange(fileRef, fileObj);

  while (fileObj.isEventPending) {
    console.log('Event pending >');
    fileObj.isEventPending = false;
    await processChange(fileRef, fileObj);
  }

  fileObj.lock = false;
  console.log('Unlock >');
};

const chokidarWatcher = chokidar
  .watch(logsDir + '/**/*.log', {
    persistent: true,
    useFsEvents: false,
    usePolling: true,
    // ignoreInitial: true,
  })
  .on('ready', () => {
    console.log('Chokidar ready');
    // console.log(chokidarWatcher.getWatched());
    console.log(chokidarWatcher.listenerCount('add'));
    console.log(chokidarWatcher.listenerCount('change'));
  })
  .on('add', fileHandler)
  .on('change', fileHandler);
