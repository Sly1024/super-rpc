# SuperRPC Electron Example

This example uses Electron to demonstrate the use of SuperRPC.

It uses Electron's IPC to provide a channel for SuperRPC to communicate between the main (Node) process and the web app (renderer).

## Build and Run

Make sure the library is built and the `./dist` folder exists.

```
npm install
npm run build
npm start
```

* This starts electron and loads the `index.html` into a "main" window.
* The "New Window" button creates a new Electron window as a child of the main window. 
* The "Show/hide others" button shows and hides the other windows (except the current one).

## The Files
* `index.html` - a simple example page 
* `app.ts` - the main app that runs in Electron's Node process
* `webapp.ts` - the web app that is bundled (Rollup) and loaded into the web page (`index.html`)
* `preload.ts` - a "preload" script that runs in an isolated context for security reasons, this exposes the `rpcChannel` that is needed for the communication
