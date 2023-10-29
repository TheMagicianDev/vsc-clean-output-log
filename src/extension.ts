// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';
import {
  IChokidarWatcherController,
  ICoreCtx,
  getApplicationDataCodeDir,
  getCleanLogWatcherController,
  getWindowName,
} from './core';

let watcherController: IChokidarWatcherController;

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  const appDataCodeDir: string = getApplicationDataCodeDir(context);
  const windowName = getWindowName(context) as string;
  if (!windowName) {
    return vscode.window.showErrorMessage(
      'Failed to start the extension. Failed to detect the window name.'
    );
  }
  const logsDir: string = path.join(appDataCodeDir, 'logs');

  const cleanLogOutputChannel = vscode.window.createOutputChannel('CleanLog');

  const ctx: ICoreCtx = {
    appDataCodeDir,
    windowName,
    logsDir,
    cleanLogOutputChannel,
  };

  // vscode.window.showInformationMessage(`CleanLog(${windowName}) Activated`);

  watcherController = getCleanLogWatcherController(ctx);

  /**
   * Toggle Start/Stop command
   * {
   *    "command": "vsc-clean-output-log.toggle_start_stop",
   *    "title": "CleanLog: start/stop toggle"
   * },
   */
  let disposable = vscode.commands.registerCommand(
    'vsc-clean-output-log.toggle_start_stop',
    async () => {
      if (!watcherController.isRunning()) {
        await watcherController.start();
        vscode.window.showInformationMessage(
          'CleanLog: Started successfully (active)'
        );
      } else {
        await watcherController.stop();
        vscode.window.showInformationMessage(
          'CleanLog: Stopped successfully (disabled)'
        );
      }
    }
  );

  context.subscriptions.push(disposable);
}

// this method is called when your extension is deactivated
export function deactivate() {
  watcherController.stop();
}
