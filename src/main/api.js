import { app, ipcMain, shell, dialog } from "electron";
import _ from "lodash";
import path from "path";
import util from "util";
import fs from "fs";
import os from "os";
import childProcess from 'child_process';
import isDev from 'electron-is-dev';
import serializeError from 'serialize-error';
import {
  addAlignments,
  addAlignment,
  startParsing,
  startTypechecking,
} from "./alignment";

import * as ipc from "../constants/ipc";

import unhandled from 'electron-unhandled';
import { reportIssue } from "../common/utils";

unhandled({
  showDialog: true,
	reportButton: reportIssue,
});

const exec = util.promisify(childProcess.exec);
const readdir = util.promisify(fs.readdir);

const state = {
  processes: {},
};

function send(event, channel, data) {
  if (!data.error) {
    return event.sender.send(channel, data);
  }
  return event.sender.send(channel, Object.assign({}, data, { error: serializeError(data.error) }));
}

ipcMain.on(ipc.OUTPUT_DIR_SELECT, (event, runId) => {
  dialog.showOpenDialog({
    title: 'Select a directory for RAxML output',
    properties: ['openDirectory', 'createDirectory'],
  }, paths => {
    if (paths.length === 0) { // On cancel
      return;
    }
    send(event, ipc.OUTPUT_DIR_SELECTED, { id: runId, outputDir: paths[0] });
  });
});

// Open a file with the OS's default file handler
ipcMain.on(ipc.FILE_OPEN, (event, fullPath) => {
  console.debug(ipc.FILE_OPEN, fullPath);
  shell.openItem(fullPath);
});

// Open a file in it's folder with native file explorer
ipcMain.on(ipc.FILE_SHOW_IN_FOLDER, (event, fullPath) => {
  console.debug(ipc.FILE_SHOW_IN_FOLDER, fullPath);
  shell.showItemInFolder(fullPath);
});

// Open a folder
ipcMain.on(ipc.FOLDER_OPEN, (event, fullPath) => {
  console.debug(ipc.FOLDER_OPEN, fullPath);
  shell.showItemInFolder(fullPath);
});

// Check if raxml output files already exist with current name
ipcMain.on(ipc.OUTPUT_CHECK, async (event, data) => {
  const { id, outputDir, outputName } = data;
  const outputFilename = `${outputName}.tre`;
  console.log('Check unused filename:', outputFilename);
  if (!outputDir) {
    send(event, ipc.OUTPUT_CHECKED, {
      id, outputDir, outputName,
      ok: true, notice: '', outputNameUnused: outputName,
      resultFilenames: [],
    });
    return;
  }
  try {
    const filenames = await readdir(outputDir);
    let outputNameUnused = outputName;
    const filterResultFilenames = filename =>
      filename.endsWith(outputNameUnused) ||
      filename.endsWith(`${outputNameUnused}.tre`);
    const resultFilenames = filenames.filter(filterResultFilenames)
    let counter = 1;
    const matchCounterName = /(\w+)_\d+$/.exec(outputName);
    const outputNameWithoutCounter = matchCounterName ? matchCounterName[1] : outputName;
    while (filenames.find(filterResultFilenames)) {
      outputNameUnused = `${outputNameWithoutCounter}_${counter}`;
      ++counter;
    }
    const ok = outputName === outputNameUnused;
    const notice = ok ? '' : `Using '${outputNameUnused}'`;
    send(event, ipc.OUTPUT_CHECKED, {
      id, outputDir, outputName, ok, notice, outputNameUnused, resultFilenames
    });
  }
  catch (error) {
    console.log(ipc.OUTPUT_CHECK, 'error:', error);
    send(event, ipc.OUTPUT_CHECKED, {
      id, ok: false, notice: error.message, error, resultFilenames
    });
  }
});

ipcMain.on(ipc.RUN_START, async (event, { id, args, binaryName, outputDir, outputFilename }) => {
  cancelProcess(id);

  const binaryDir = path.join(__static, 'bin');
  const binaryPath = path.resolve(binaryDir, binaryName);

  console.log(`Run ${id}:\n  output filename id: ${outputFilename}\n  output dir: ${outputDir}\n  binary: ${binaryName}\n  binary path: ${binaryDir}\n  args:`, args);

  // TODO: When packaged, RAxML throws error trying to write the file RAxML_flagCheck:
  // "The file RAxML_flagCheck RAxML wants to open for writing or appending can not be opened [mode: wb], exiting ..."
  const checkFlags = isDev;
  if (checkFlags) {
    for (const arg of args) {
      try {
        const { stdout, stderr } = await exec(`${binaryPath} ${arg.join(' ')} --flag-check`);
        console.log(stdout, stderr);
      }
      catch (err) {
        console.error('Flag check run error:', err);
        send(event, ipc.RUN_ERROR, { id, error: err });
        return;
      }
    }
  }

  for (const arg of args) {
    try {
      console.log(`Run ${binaryName} with args:`, arg)
      await runProcess(id, event, binaryPath, arg);
    }
    catch (err) {
      console.error('Run error:', err);
      send(event, ipc.RUN_ERROR, { id, error: err });
      return;
    }
  }

  const filenames = await readdir(outputDir);
  const resultFilenames = filenames.filter(filename =>
    filename.endsWith(outputFilename));

  send(event, ipc.RUN_FINISHED, { id, resultDir: outputDir, resultFilenames });


});

ipcMain.on(ipc.RUN_CANCEL, (event, arg) => {
  const id = arg;
  console.log(`Cancel raxml process ${id}...`);
  cancelProcess(id);
  // send(event, ipc.RUN_CLOSED, { id });
});

ipcMain.on('open-item', (event, arg) => {
  console.log('Open item:', arg);
  shell.openItem(arg);
});

function cancelProcess(id) {
  if (state.processes[id]) {
    const proc = state.processes[id];
    delete state.processes[id];
    proc.kill();
    console.log(`Killed RAxML process ${id}`);
  }
}

function spawnProcess(binaryPath, args) {
  const binaryDir = path.dirname(binaryPath);
  const binaryName = path.basename(binaryPath);

  const proc = childProcess.spawn(binaryName, args, {
    stdio: 'pipe',
    cwd: os.homedir(),
    env: { PATH: `${process.env.path}:${binaryDir}` },
  });
  return proc;
}

async function runProcess(id, event, binaryPath, args) {
  return new Promise((resolve, reject) => {

    cancelProcess(id);
    try {

      const proc = spawnProcess(binaryPath, args);
      state.processes[id] = proc;

      proc.stdout.on('data', buffer => {
        const content = String(buffer);
        console.log('on stdout:', content);
        send(event, ipc.RUN_STDOUT, { id, content });
      });

      proc.stderr.on('data', buffer => {
        const content = String(buffer);
        console.log('on stderr:', content);
        send(event, ipc.RUN_STDERR, { id, content });
      });

      proc.on('close', code => {
        console.log('on close:', code);
        delete state.processes[id];
        if (code && code !== 0) {
          return reject(new Error(`Check console output for error.`));
        }
        resolve(code);
      });
    }
    catch (err) {
      console.log('Run catch error:', err);
      reject(err);
    }
  });
}

// Send promise with exit code and stdout
async function execProcess(binaryPath, args) {
  // const binaryDir = path.dirname(binaryPath);
  // const binaryName = path.basename(binaryPath);
  return exec(`${binaryPath} ${args.join(' ')}`);
}









// Open a folder with native file explorer in given path
ipcMain.on(ipc.ALIGNMENT_EXAMPLE_FILES_GET_IPC, (event) => {
  console.log('api', ipc.ALIGNMENT_EXAMPLE_FILES_GET_IPC);
  // const dir = app.isPackaged ?
  //   path.join(path.dirname(app.getAppPath()), '..', 'example-files') :
  //   path.join(app.getAppPath(), 'example-files', 'fasta');
  // __static is defined by electron-webpack
  const dir = path.join(__static, 'example-files', 'fasta');

  fs.readdir(dir, (err, files) => {
    const filePaths = files.map(filename => ({
      dir: dir,
      path: path.join(dir, filename),
      name: filename,
    }));
    send(event, ipc.ALIGNMENT_EXAMPLE_FILES_GOT_IPC, filePaths);
  });
});

// Open a folder with native file explorer in given path
ipcMain.on(ipc.FOLDER_OPEN_IPC, (event, outputPath) => {
  console.log('api', ipc.FOLDER_OPEN_IPC, outputPath);
  shell.showItemInFolder(outputPath);
});

// Open a file with the OS's default file handler
ipcMain.on(ipc.FILE_OPEN_IPC, (event, arg) => {
  console.log('api', ipc.FILE_OPEN_IPC);
  shell.openItem(arg);
});

// Open a dialog to select a file
ipcMain.on(ipc.TREE_SELECT, (event, runId) => {
  console.log('api', ipc.TREE_SELECT);
  dialog.showOpenDialog({
    title: 'Select a tree file',
    properties: ['openFile']
  }, filePaths => {
    if (filePaths.length === 0) { return; }
    send(event, ipc.TREE_SELECTED, { id: runId, filePath: filePaths[0] });
  });
});

// Open a dialog to select alignments
ipcMain.on(ipc.ALIGNMENT_SELECT_IPC, (event) => {
  console.log('api', ipc.ALIGNMENT_SELECT_IPC);
  dialog.showOpenDialog({
    title: 'Select an alignment',
    properties: ['openFile', 'multiSelections']
  }, filePaths => {
    if (filePaths.length === 0) { return; }
    const alignments = filePaths.map(filePath => {
    return {
        path: filePath,
        name: path.basename(filePath)
      };
    });
    send(event, ipc.ALIGNMENT_SELECTED_IPC, alignments);
  });
});

// // Receive a new batch of alignments dropped into the app
ipcMain.on(ipc.ALIGNMENTS_ADDED_IPC, (event, alignments) => {
  console.log('api', ipc.ALIGNMENTS_ADDED_IPC);
  addAlignments(alignments);
});

ipcMain.on(ipc.ALIGNMENT_ADDED_IPC, (event, filePath) => {
  console.log('api', ipc.ALIGNMENT_ADDED_IPC);
  addAlignment(filePath);
});

ipcMain.on(ipc.PARSING_START_IPC, (event, alignments) => {
  console.log('api', ipc.PARSING_START_IPC);
  startParsing(alignments);
});

ipcMain.on(ipc.TYPECHECKING_START_IPC, (event, alignments) => {
  console.log('api', ipc.TYPECHECKING_START_IPC);
  startTypechecking(alignments);
});

// ipcMain.on(ipc.CHECKRUN_START_IPC, (event, alignments) => {
//   console.log('api', ipc.CHECKRUN_START_IPC);
//   startCheckrun(alignments);
// });

// ipcMain.on(ipc.RUN_PROPOSED_IPC, (event, alignments) => {
//   console.log('api', ipc.RUN_PROPOSED_IPC);
//   createRun(alignments);
// });

// ipcMain.on(ipc.CALCULATION_START_IPC, (event, runs) => {
//   console.log('api', ipc.CALCULATION_START_IPC);
//   startRuns(runs);
// });

// function startFlagsrun(run) {
//   console.log('startFlagsrun');
//   if (!run.argsList) {
//     console.log('No args list given');
//   }
//   // An args list=array can have multiple entries
//   const argsPromises = _.map(run.argsList, args => {
//     // Transform args as object into array
//     const arrayArgs = transformArgsToArray(args);
//     arrayArgs.push('--flag-check');
//     return new Promise((resolve, reject) => {
//       runRaxmlWithArgs(run.path, arrayArgs, {
//         stdout: data => {
//           const dataString = String(data);
//           run.flagsrunData = dataString;
//           sendToMainWindow(ipc.FLAGSRUN_PROGRESS_IPC, { run });
//         },
//         close: code => {
//           run.flagsrunCode = code;
//           console.log(code);
//           console.log('Flagsrun end');
//           sendToMainWindow(ipc.FLAGSRUN_END_IPC, { run });
//           if (code === 255) {
//             const message = run.flagsrunData.toLowerCase().split('error');
//             const error = message[message.length - 1];
//             console.log('Flagsrun stdout close: Error code given for RAxML.');
//             console.log('Flagsrun data', run.flagsrunData);
//             // Send all text after the word error along as error message
//             run.flagsrunComplete = true;
//             sendToMainWindow(ipc.FLAGSRUN_ERROR_IPC, { run, error });
//             reject(run);
//           }
//           if (code === 0) {
//             resolve(run);
//           } else {
//             reject(run);
//           }
//         }
//       });
//     });
//   });
//   return new Promise((resolve, reject) => {
//     Promise.all(argsPromises).then(results => {
//       console.log('All flagsrun resolved', run);
//       resolve(run);
//     });
//   });
// }

// ipcMain.on(ipc.RUN_START_IPC, (event, run) => {
//   console.log('api', ipc.RUN_START_IPC);
//   const flagsrunPromise = startFlagsrun(run);
//   flagsrunPromise
//     .then(run => {
//       // Chain on the actual calculation
//       startRuns([run]);
//       return run;
//     })
//     .catch(error => console.log(error));
// });

// ipcMain.on(ipc.CALCULATION_CANCEL_IPC, (event, run) => {
//   console.log('api', ipc.CALCULATION_CANCEL_IPC);
//   cancelCalculations(run);
// });