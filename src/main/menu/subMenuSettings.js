import { BrowserWindow } from 'electron';

import * as ipc from "../../constants/ipc";

const subMenuSettings = {
  label: 'Settings',
  submenu: [
    {
      label: 'Light mode',
      type: 'checkbox',
      check: false,
      click() {
        BrowserWindow.getFocusedWindow().webContents.send(ipc.TOGGLE_LIGHT_MODE);
      }
    },
  ]
};

export default subMenuSettings;
