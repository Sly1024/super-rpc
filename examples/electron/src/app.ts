import { app, BrowserWindow, ipcMain } from 'electron';
import { nanoid } from 'nanoid/non-secure';
import * as path from 'path';
import { RPC_Message } from '../../../dist/rpc-message-types';
import { RPCChannel, SuperRPC } from '../../../dist/super-rpc';

const preloadPath = path.resolve(path.join(__dirname, './preload.js'));

function createWindow() {
    const rpc = new SuperRPC(nanoid);

    rpc.connect({
        receive: (callback: (message: RPC_Message, replyChannel?: RPCChannel, context?: any) => void) => {
            ipcMain.on('channel', (event, message) => {
                callback(message, {
                    sendAsync: (msg) => event.reply('channel', msg),
                    sendSync: (msg) => { event.returnValue = msg; }
                }, event);  // <- this "event" is available as rpc.currentContext during function calls
            });
        }
    });

    const myServiceObject = {
        createWindow: (options: any) => new BrowserWindow({
            ...options,
            webPreferences: {
                ...options?.webPreferences,
                nativeWindowOpen: true,
                nodeIntegration: false,
                contextIsolation: true,
                preload: preloadPath
            }
        }),
        getCurrentWindow: () => BrowserWindow.fromWebContents(rpc.currentContext.sender)
    };

    rpc.registerHostObject('serviceObj', myServiceObject, {
        functions: [
            'createWindow',
            'getCurrentWindow',
        ]
    });

    rpc.registerHostClass('BrowserWindow', BrowserWindow, {
        ctor: { returns: 'sync' },
        static: {
            functions: [
                { name: 'fromId', returns: 'sync' },
                'getAllWindows'
            ],
        },
        instance: {
            readonlyProperties: ['id'],
            proxiedProperties: ['fullScreen', 'title'],
            functions: [
                'close', 'focus', 'blur', 'show', 'hide', 'setBounds', 'getBounds',
                'getParentWindow', 'setParentWindow', 'loadURL', 'loadFile',
                { name: 'isVisible', returns: 'sync' },
                { name: 'addListener', returns: 'void', arguments: [{ idx: 1, type: 'function', returns: 'void' }]},
                { name: 'removeListener', returns: 'void', arguments: [{ idx: 1, type: 'function', returns: 'void' }]}
            ]
        }
    });

    const mainWindow = myServiceObject.createWindow({
        width: 1200, height: 850,
    });

    mainWindow.loadFile('../index.html');
}


app.whenReady().then(() => {
    createWindow();
});

app.on('window-all-closed', () => app.quit());
