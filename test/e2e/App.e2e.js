import { ClientFunction, Selector } from 'testcafe';
import { ReactSelector, waitForReact } from 'testcafe-react-selectors';
import { setElectronDialogHandler } from 'testcafe-browser-provider-electron';

import { getPageUrl, getPageTitle } from './helpers';

const assertNoConsoleErrors = async t => {
  const { error } = await t.getBrowserConsoleMessages();
  await t.expect(error).eql([]);
};

fixture`Entry Page tests`
  .page('../../app/app.html?mainWindow')
  .afterEach(assertNoConsoleErrors);

test(
  "should haven't any logs in console of main window",
  assertNoConsoleErrors
);

test('should open window', async t => {
  await t.expect(getPageTitle()).eql('raxmlGUI2');
});

test.only('load an alignment', async t => {
  await waitForReact();

  await setElectronDialogHandler((type, browserWindow, options) => {
    console.log('type', type);
    console.log('browserWindow', browserWindow);
    console.log('options', options);
    // browserWindow, options are standard arguments of the opening dialog, you can use it for your purposes
    if (type !== 'open-dialog') return;

    // it returns the file path from the open dialog
    return ['../../example_files/fasta/nucleotide.txt'];
  });

  await t.setNativeDialogHandler((type, text, url) => {
    console.log('type', type);
    console.log('text', text);
    console.log('url', url);
  });

  console.log('Test log');
  // const dropzone = ReactSelector('RgAlignmentDropzone');
  // TODO: I do not like this selector, but I did not get testcafe-react-selectors to work
  const dropzone = Selector('.RgAlignmentDropzone').find('div');
  // console.log(input);
  await t
    .wait(1000)
    .click(dropzone)
    .wait(100);
});
