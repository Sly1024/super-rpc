import { contextBridge, ipcRenderer } from 'electron';
import type { RPCChannel, RPC_Message } from '../../../dist';

// a communication channel
const channel: RPCChannel = {
    sendSync: (message: RPC_Message) => {
        const result = ipcRenderer.sendSync('channel', message);
        if (result?.error) throw new Error(result.error);
        return result;
    },
    sendAsync: (message: RPC_Message) => ipcRenderer.send('channel', message),
    receive: (callback: (message: RPC_Message, replyChannel?: RPCChannel) => void) => {
        ipcRenderer.on('channel', (_event, message) => callback(message));
    }
};

contextBridge.exposeInMainWorld('rpcChannel', channel);
