import { nanoid } from 'nanoid/non-secure';
import { RPCChannel, SuperRPC } from '../../../dist';
import type { BrowserWindow as ElectronBrowserWindow } from 'electron';

// this is exposed by the preload script as a global object
declare const rpcChannel: RPCChannel;

// create a SuperRPC instance, connect to the channel
const rpc = new SuperRPC(nanoid);
rpc.connect(rpcChannel);

// Need to get the descriptors so we can build proxy objects based on them.
rpc.requestRemoteDescriptors();

export const service = rpc.getProxyObject('serviceObj');
export const BrowserWindow = <typeof ElectronBrowserWindow>rpc.getProxyClass('BrowserWindow');

const mainWindow = BrowserWindow.fromId(1);
let currentWindow: ElectronBrowserWindow;

(async () => {
    // add a "move" listener to the current window and display the bounds rectangle in a span
    const boundsSpan = document.getElementById('boundsSpan');
    currentWindow = await service.getCurrentWindow();
    await currentWindow.addListener('move', async () => {
        boundsSpan.textContent = JSON.stringify(await currentWindow.getBounds());
    });
})();

// clicking on the "New Window" button we create a new Electron window and load the same index.html into it
document.getElementById('newWindowBtn').addEventListener('click', async () => {
    const win = await service.createWindow({
        width: 800, height: 600
    });
    await win.setParentWindow(mainWindow);
    await win.loadFile('../index.html');
    win.title = 'Example Popup';
});

document.getElementById('showHideBtn').addEventListener('click', async () => {
    const allWindows = await BrowserWindow.getAllWindows();
    for (const win of allWindows) {
        if (win !== currentWindow) {
            if (win.isVisible()) {
                win.hide();
            } else {
                win.show();
            }
        }
    }
});