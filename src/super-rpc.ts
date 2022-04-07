import { ProxyObjectRegistry, rpc_disposed } from './proxy-object-registry';
import {
    AnyConstructor,
    AnyFunction,
    ClassDescriptor, ClassDescriptors, Descriptor, FunctionDescriptor, FunctionDescriptors, FunctionReturnBehavior,
    getArgumentDescriptor, getEventDescriptor, getFunctionDescriptor, getPropertyDescriptor, getPropName,
    isFunctionDescriptor, ObjectDescriptor, ObjectDescriptors, ObjectDescriptorWithProps, processFunctionDescriptor, processObjectDescriptor
} from './rpc-descriptor-types';
import type {
    RPC_AnyCallAction, RPC_AnyCallMessage,
    RPC_AsyncCallAction, RPC_DescriptorsResultMessage,
    RPC_Message, RPC_SyncCallAction, RPC_VoidCallAction
} from './rpc-message-types';


type PromiseCallbacks = {
    resolve: (data?: any) => void;
    reject: (data?: any) => void;
};

type HostRegistryEntry<TDescriptor extends Descriptor> = {
    target: any;
    descriptor: TDescriptor;
};

const hostObjectId = Symbol('hostObjectId');
const proxyObjectId = Symbol('proxyObjectId');
const classIdSym = Symbol('classId');

/**
 * The channel used for the communication.
 * Can support synchronous and/or asynchronous messages.
 *
 * Note: if sync/async is not supported, make sure to use the correct return type for functions: [[FunctionReturnBehavior]].
 */
export interface RPCChannel {
    /**
     * Sends a message and returns the response synchronously.
     */
    sendSync?: (message: RPC_Message) => any;

    /**
     * Sends a message asnychronously. The response will come via the `receive` callback function.
     */
    sendAsync?: (message: RPC_Message) => void;

    /**
     * Register a callback for when an async message arrives.
     * Note: The "context" is exposed during function calls via the [[SuperRPC.currentContext]] property.
     */
    receive?: (callback: (message: RPC_Message, replyChannel?: RPCChannel, context?: any) => void) => void;
}

/**
 * The SuperRPC is the central piece. An instance must be created on both sides.
 *
 * Objects, functions or classes can be registered on the "host" side
 * (see [[registerHostObject]], [[registerHostClass]]) and then functions/properties can be
 * called from the "client" side (see [[getProxyObject]], [[getProxyClass]]).
 *
 * The RPC service is symmetric, so depending on the use-case (and the channel),
 * both side can be "host" and "client" at the same time.
 *
 * The constructor needs a function to generate unique IDs for objects.
 * In order to have no dependencies this needs to be passed in.
 * For convenience the examples use [nanoid](https://www.npmjs.com/package/nanoid).
 */
export class SuperRPC {
    private channel!: RPCChannel;

    private remoteObjectDescriptors?: ObjectDescriptors;
    private remoteFunctionDescriptors?: FunctionDescriptors;
    private remoteClassDescriptors?: ClassDescriptors;
    private remoteDescriptorsCallbacks?: PromiseCallbacks;

    private asyncCallbacks = new Map<string, PromiseCallbacks>();
    private callId = 0;

    private readonly proxyObjectRegistry = new ProxyObjectRegistry();
    private readonly proxyClassRegistry = new Map<string, AnyConstructor>();

    private readonly hostObjectRegistry = new Map<string, HostRegistryEntry<ObjectDescriptor>>();
    private readonly hostFunctionRegistry = new Map<string, HostRegistryEntry<FunctionDescriptor>>();
    private readonly hostClassRegistry = new Map<string, HostRegistryEntry<ClassDescriptor>>();

    /**
     * @param objectIdGenerator A function to generate a unique ID for an object.
     *
     * When sending an object to the other side that can not be serialized, we
     * generate an ID and send that instead. The other side creates a proxy object
     * that represents the remote object.
     */
    constructor(private objectIdGenerator: () => string) {
    }

    /**
     * Stores the current "context" object that is passed to the callback of the [[RPCChannel.receive]] function.
     */
    public currentContext: any;

    /**
     * Connect the service to a channel.
     */
    connect(channel: RPCChannel) {
        this.channel = channel;
        channel.receive?.(this.messageReceived.bind(this));
    }

    /**
     * Register an object in the service to be called remotely.
     * @param objId An ID that the "client" side uses to identify this object.
     * @param target The target object
     * @param descriptor Describes which functions/properties to expose
     */
    registerHostObject(objId: string, target: object, descriptor: ObjectDescriptor) {
        descriptor.type = 'object';
        (target as any)[hostObjectId] = objId;
        this.hostObjectRegistry.set(objId, { target, descriptor });
    }

    /**
     * Register a function in the service to be called remotely.
     * @param objId An ID that the "client" side uses to identify this function.
     * @param target The target function
     * @param descriptor Describes arguments and return behavior ([[FunctionReturnBehavior]])
     */
    registerHostFunction(objId: string, target: AnyFunction, descriptor: FunctionDescriptor = {}) {
        descriptor.type = 'function';
        (target as any)[hostObjectId] = objId;
        this.hostFunctionRegistry.set(objId, { target, descriptor });
    }

    /**
     * Register a class in the service.
     *
     * When an instance of this class is passed to the other side, only the "readonlyProperties" are sent (see [[ClassDescriptor]]).
     * Functions and proxied properties are generated there and those call back to the original object.
     *
     * Even the constructor can be proxied.
     *
     * Note: static functions/properties act as if the class was a normal host object.
     *
     * @param classId An ID to identify the class on the client side.
     * @param classCtor The class itself (its constructor function)
     * @param descriptor What properties/functions to expose
     */
    registerHostClass(classId: string, classCtor: AnyConstructor, descriptor: ClassDescriptor) {
        descriptor.type = 'class';
        descriptor.classId = classId;

        if (descriptor.static) {
            this.registerHostObject(classId, classCtor, descriptor.static);
        }

        if (descriptor.ctor) {
            this.registerHostFunction(classId, <any>classCtor, descriptor.ctor);
        }

        (classCtor as any)[classIdSym] = classId;
        this.hostClassRegistry.set(classId, { target: classCtor, descriptor });
    }

    /**
     * Send a request to get the descriptors for the registered host objects from the other side.
     * Uses synchronous communication if possible and returns `true`/`false` based on if the descriptors were received.
     * If sync is not available, it uses async messaging and returns a Promise.
     */
    requestRemoteDescriptors() {
        if (this.channel?.sendSync) {
            const response = this.sendSync({ action: 'get_descriptors' }) as RPC_DescriptorsResultMessage;
            return this.setRemoteDescriptors(response);
        }

        return new Promise<void>((resolve, reject) => {
            this.sendAsync({ action: 'get_descriptors' });
            this.remoteDescriptorsCallbacks = { resolve, reject };
        });
    }

    private setRemoteDescriptors(response: RPC_DescriptorsResultMessage) {
        if (typeof response !== 'object') return false;

        if (response.classes) {
            this.remoteClassDescriptors = response.classes;
        }
        if (response.objects) {
            this.remoteObjectDescriptors = response.objects;
        }
        if (response.functions) {
            this.remoteFunctionDescriptors = response.functions;
        }
        return true;
    }

    /**
     * Send the descriptors for the registered host objects to the other side.
     * If possible, the message is sent synchronously.
     * This is a "push" style message, for "pull" see [[requestRemoteDescriptors]].
     */
    sendRemoteDescriptors(replyChannel = this.channel) {
        this.sendSyncIfPossible({
            action: 'descriptors',
            objects: this.getLocalDescriptors(this.hostObjectRegistry, processObjectDescriptor),
            functions: this.getLocalDescriptors(this.hostFunctionRegistry, processFunctionDescriptor),
            classes: this.getLocalDescriptors(this.hostClassRegistry),
        }, replyChannel);
    }

    private getLocalDescriptors<T extends ObjectDescriptor|FunctionDescriptor|ClassDescriptor>(
        registry: Map<string, HostRegistryEntry<T>>,
        processFn?: (descr: T, obj: any) => T
    ): T extends ObjectDescriptor ? ObjectDescriptors : T extends FunctionDescriptor ? FunctionDescriptors : ClassDescriptors
    {
        const descriptors: any = {};
        for (const key of registry.keys()) {
            // .get() could return undefined, but we know it will never do that, since we iterate over existing keys
            // therefore it is safe to cast it to the entry types
            const entry = <HostRegistryEntry<T>>registry.get(key);

            if (!entry.descriptor) continue;

            let descr = <T>{ ...entry.descriptor };
            descr = processFn?.(descr, entry.target) ?? descr;
            descriptors[key] = descr;

            if (entry.descriptor.type === 'object' && entry.descriptor.readonlyProperties) {
                const props: any = {};
                for (const prop of entry.descriptor.readonlyProperties) {
                    props[prop] = (entry as HostRegistryEntry<ObjectDescriptor>).target[prop];
                }
                (descr as ObjectDescriptorWithProps).props = props;
            }
        }
        return descriptors;
    }

    private sendSync(message: RPC_Message, channel = this.channel) {
        this.addMarker(message);
        return channel?.sendSync?.(message);
    }

    private sendAsync(message: RPC_Message, channel = this.channel) {
        this.addMarker(message);
        channel?.sendAsync?.(message);
    }

    private sendSyncIfPossible(message: RPC_Message, channel = this.channel) {
        return channel?.sendSync ? this.sendSync(message, channel) : this.sendAsync(message, channel);
    }

    private sendAsyncIfPossible(message: RPC_Message, channel = this.channel) {
        return channel?.sendAsync ? this.sendAsync(message, channel) : this.sendSync(message, channel);
    }

    private addMarker(message: RPC_Message) {
        message.rpc_marker = 'srpc';
    }

    private checkMarker(message: RPC_Message) {
        return typeof message === 'object' && message.rpc_marker === 'srpc';
    }

    private callTargetFunction(msg: RPC_AnyCallMessage, replyChannel = this.channel) {
        const entry = (msg.action === 'fn_call' || msg.action === 'ctor_call' ? this.hostFunctionRegistry : this.hostObjectRegistry).get(msg.objId);
        let result: any;
        let success = true;
        try {
            if (!entry) throw new Error(`No object found with ID '${msg.objId}'`);
            let scope: unknown = null;
            let { descriptor, target } = entry;

            let args: any[];

            switch (msg.action) {
                case 'prop_get': {
                    result = target[msg.prop];
                    break;
                }
                case 'prop_set': {
                    const descr = getPropertyDescriptor(descriptor as ObjectDescriptor, msg.prop);
                    const result = this.processAfterDeserialization(msg.args[0], replyChannel, descr?.set?.arguments?.[0]);
                    // special case for when the property getter is async and the setter gets a Promise
                    if (result?.constructor === Promise && (descr?.get?.returns === 'async' || !replyChannel.sendSync)) {
                        result.then((value: any) => target[msg.prop] = value);
                    } else {
                        target[msg.prop] = result;
                    }
                    break;
                }
                case 'method_call': {
                    scope = target;
                    descriptor = getFunctionDescriptor(descriptor as ObjectDescriptor, msg.prop);
                    if (!descriptor && !target[msg.prop]) {
                        // check if it's an event (add_EvtName or remove_EvtName)
                        // map it to addEventListener/removeEventListener(eventName, listener)
                        const [addOrRemove, eventName] = msg.prop.split('_');
                        if (eventName && (addOrRemove === 'add' || addOrRemove === 'remove') &&
                            typeof (target = target[addOrRemove + 'EventListener']) === 'function')
                        {
                            const evtDescriptor = getEventDescriptor(descriptor, eventName);
                            args = [eventName, ...this.deserializeFunctionArgs(evtDescriptor, msg.args, replyChannel)];
                        }
                    } else {
                        target = target[msg.prop];
                    }
                    if (typeof target !== 'function') throw new Error(`Property ${msg.prop} is not a function on object ${msg.objId}`);
                    // NO break here!
                }
                // eslint-disable-next-line no-fallthrough
                case 'fn_call': {
                    args ??= this.deserializeFunctionArgs(descriptor as FunctionDescriptor, msg.args, replyChannel);
                    result = target.apply(scope, args);
                    break;
                }
                case 'ctor_call': {
                    args = this.deserializeFunctionArgs(descriptor as FunctionDescriptor, msg.args, replyChannel);
                    result = new target(...args);
                    break;
                }
            }

            if (msg.callType === 'async') {
                Promise.resolve(result)
                    .then(value => result = this.processBeforeSerialization(value, replyChannel), err => { result = err?.toString?.(); success = false; })
                    .then(() => this.sendAsync({ action: 'fn_reply', callType: 'async', success, result, callId: msg.callId }, replyChannel));
            } else if (msg.callType === 'sync') {
                result = this.processBeforeSerialization(result, replyChannel);
            }
        } catch (err: any) {
            success = false;
            result = err?.toString?.();
        }
        if (msg.callType === 'sync') {
            this.sendSync({ action: 'fn_reply', callType: 'sync', success, result }, replyChannel);
        } else if (msg.callType === 'async' && !success) {
            this.sendAsync({ action: 'fn_reply', callType: 'async', success, result, callId: msg.callId }, replyChannel);
        }
    }

    private messageReceived(message: RPC_Message, replyChannel = this.channel, context?: any) {
        this.currentContext = context;

        if (this.checkMarker(message)) {
            switch (message.action) {
                case 'get_descriptors': {
                    this.sendRemoteDescriptors(replyChannel);
                    break;
                }
                case 'descriptors': {
                    const success = this.setRemoteDescriptors(message);
                    this.remoteDescriptorsCallbacks?.[success ? 'resolve' : 'reject']();
                    this.remoteDescriptorsCallbacks = undefined;
                    break;
                }
                case 'prop_get':
                case 'prop_set':
                case 'ctor_call':
                case 'fn_call':
                case 'method_call': {
                    this.callTargetFunction(message, replyChannel);
                    break;
                }
                case 'obj_died': {
                    this.hostObjectRegistry.delete(message.objId);
                    break;
                }
                case 'fn_reply': {
                    if (message.callType === 'async') {
                        const result = this.processAfterDeserialization(message.result, replyChannel);
                        const callbacks = this.asyncCallbacks.get(message.callId);
                        callbacks?.[message.success ? 'resolve' : 'reject'](result);
                        this.asyncCallbacks.delete(message.callId);
                    }
                    break;
                }
            }
        }
    }


    private serializeFunctionArgs(func: FunctionDescriptor, args: any[], replyChannel: RPCChannel) {
        return args.map((arg, idx) => this.processBeforeSerialization(arg, replyChannel, getArgumentDescriptor(func, idx)));
    }

    private deserializeFunctionArgs(func: FunctionDescriptor, args: any[], replyChannel: RPCChannel) {
        return args.map((arg, idx) => this.processAfterDeserialization(arg, replyChannel, getArgumentDescriptor(func, idx)));
    }

    private createVoidProxyFunction(objId: string|null, func: FunctionDescriptor, action: RPC_VoidCallAction, replyChannel: RPCChannel) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const _this = this;
        const fn = function (this: any, ...args: any[]) {
            if ((fn as any)[rpc_disposed]) throw new Error('Remote function has been disposed');
            _this.sendAsyncIfPossible({
                action,
                callType: 'void',
                objId: objId ?? this[proxyObjectId],
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                prop: func.name!,
                args: _this.serializeFunctionArgs(func, args, replyChannel)
            }, replyChannel);
        };
        return fn;
    }

    private createSyncProxyFunction(objId: string|null, func: FunctionDescriptor, action: RPC_SyncCallAction, replyChannel: RPCChannel) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const _this = this;
        const fn = function (this: any, ...args: any[]) {
            if ((fn as any)[rpc_disposed]) throw new Error('Remote function has been disposed');
            const response = _this.sendSync({
                action,
                callType: 'sync',
                objId: objId ?? this[proxyObjectId],
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                prop: func.name!,
                args: _this.serializeFunctionArgs(func, args, replyChannel)
            }, replyChannel);

            if (!response) throw new Error('No response received');
            if (!_this.checkMarker(response)) throw new Error(`Invalid response ${JSON.stringify(response)}`);

            if (!response.success) throw new Error(response.result);
            return _this.processAfterDeserialization(response.result, replyChannel);
        };
        return fn;
    }

    private createAsyncProxyFunction(objId: string|null, func: FunctionDescriptor, action: RPC_AsyncCallAction, replyChannel: RPCChannel) {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const _this = this;
        const fn = function (this: any, ...args: any[]) {
            return new Promise((resolve, reject) => {
                if ((fn as any)[rpc_disposed]) throw new Error('Remote function has been disposed');
                _this.callId++;
                _this.sendAsync({
                    action,
                    callType: 'async',
                    objId: objId ?? this[proxyObjectId],
                    callId: _this.callId.toString(),
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    prop: func.name!,
                    args: _this.serializeFunctionArgs(func, args, replyChannel)
                }, replyChannel);
                _this.asyncCallbacks.set(_this.callId.toString(), { resolve, reject });
            });
        };
        return fn;
    }

    private createProxyFunction(
        objId: string | null,
        prop: string | FunctionDescriptor,
        action: RPC_AnyCallAction,
        defaultCallType: FunctionReturnBehavior = 'async',
        replyChannel = this.channel): AnyFunction | AnyConstructor
    {
        const descriptor = (typeof prop === 'object') ? prop : { name: prop };
        let callType = descriptor?.returns || defaultCallType;

        if (callType === 'async' && !replyChannel.sendAsync) callType = 'sync';
        if (callType === 'sync' && !replyChannel.sendSync) callType = 'async';

        switch (callType) {
            case 'void': return this.createVoidProxyFunction(objId, descriptor, <RPC_VoidCallAction>action, replyChannel);
            case 'sync': return this.createSyncProxyFunction(objId, descriptor, <RPC_SyncCallAction>action, replyChannel);
            default: return this.createAsyncProxyFunction(objId, descriptor, <RPC_AsyncCallAction>action, replyChannel);
        }
    }

    /**
     * Gets or creates a proxy object that represents a host object from the other side.
     *
     * This side must have the descriptor for the object.
     * See [[sendRemoteDescriptors]], [[requestRemoteDescriptors]].
     */
    getProxyObject(objId: string) {
        let obj: any = this.proxyObjectRegistry.get(objId);
        if (obj) return obj;

        const descriptor = this.remoteObjectDescriptors?.[objId];
        if (!descriptor) {
            throw new Error(`No object registered with ID '${objId}'`);
        }

        obj = this.createProxyObject(objId, descriptor);

        this.proxyObjectRegistry.register(objId, obj);
        return obj;
    }

    /**
     * Gets or creates a proxy function that represents a host object from the other side.
     *
     * This side must have the descriptor for the function.
     * See [[sendRemoteDescriptors]], [[requestRemoteDescriptors]].
     */
    getProxyFunction(objId: string) {
        let obj: any = this.proxyObjectRegistry.get(objId);
        if (obj) return obj;

        const descriptor = this.remoteFunctionDescriptors?.[objId];
        if (!descriptor) {
            throw new Error(`No function registered with ID '${objId}'`);
        }

        obj = this.createProxyFunction(objId, descriptor, 'fn_call');

        this.proxyObjectRegistry.register(objId, obj);
        return obj;
    }

    /**
     * Gets or creates a proxy "class" that will serve multiple purposes.
     * - Static functions/properties on the class are proxied the same way as on a regular "host" object
     * - If specified the constructor actually constructs an instance of the registered host class on the other side
     * and the returned instance will represent the remote instance, with the specified functions/properties working
     * on its prototype as expected.
     * - If an instance of the registered host class is being sent from the other side,
     * an instance of this proxy class will be created and passed on this side.
     */
    getProxyClass(classId: string): AnyConstructor {
        let clazz = this.proxyClassRegistry.get(classId);
        if (clazz) return clazz;

        const descriptor = this.remoteClassDescriptors?.[classId];
        if (!descriptor) {
            throw new Error(`No class registered with ID '${classId}'`);
        }

        clazz = <AnyConstructor>(descriptor.ctor ? this.createProxyFunction(classId, descriptor.ctor, 'ctor_call', 'sync')
            : function () { throw new Error(`Constructor of class '${classId}' is not defined`); });

        // create the proxy functions/properties on the prototype with no objId, so each function will look up "proxyObjectId" on "this"
        // so the prototype will work with multiple instances
        this.createProxyObject(null, descriptor.instance as ObjectDescriptorWithProps, clazz.prototype);

        // add static functions/props
        const staticDescr = descriptor.static as ObjectDescriptorWithProps ?? {};
        const objDescr = this.remoteObjectDescriptors?.[classId];
        if (!isFunctionDescriptor(objDescr)) {
            staticDescr.props = objDescr?.props;
        }
        this.createProxyObject(classId, staticDescr, clazz);

        this.proxyClassRegistry.set(classId, clazz);

        return clazz;
    }

    private createProxyObject(objId: string|null, descriptor?: ObjectDescriptorWithProps, obj: any = {}) {
        Object.assign(obj, descriptor?.props);

        for (const prop of descriptor?.functions ?? []) {
            obj[getPropName(prop)] = this.createProxyFunction(objId, prop, 'method_call');
        }

        const setterCallType = this.channel.sendSync ? 'sync' : 'void';

        for (const prop of descriptor?.proxiedProperties ?? []) {
            const descr = typeof prop === 'string' ? { name: prop } : prop;
            Object.defineProperty(obj, descr.name, {
                get: <AnyFunction>this.createProxyFunction(objId, { ...descr.get, name: descr.name }, 'prop_get', 'sync'),
                set: descr.getOnly ? undefined : <AnyFunction>this.createProxyFunction(objId, { ...descr.set, name: descr.name }, 'prop_set', setterCallType)
            });
        }

        if (descriptor?.events && descriptor.events.length > 0) {
            const eventNames = descriptor.events.map(descr => typeof descr === 'object' ? descr.name : descr);
            const addListenerFunctions = new Map<string, AnyFunction>();
            const removeListenerFunctions = new Map<string, AnyFunction>();
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            const _this = this;
            obj.addEventListener = function (eventName: string, listener: AnyFunction) {
                if (!eventNames.includes(eventName)) throw new Error(`No "${eventName}" event found on object "${objId}".`);

                let proxyFunc = addListenerFunctions.get(eventName);
                if (!proxyFunc) {
                    const descr = { ...getEventDescriptor(descriptor, eventName), name: 'add_' + eventName };
                    proxyFunc = <AnyFunction>_this.createProxyFunction(objId, descr, 'method_call');
                    addListenerFunctions.set(eventName, proxyFunc);
                }
                proxyFunc(listener);
            };
            obj.removeEventListener = function (eventName: string, listener: AnyFunction) {
                if (!eventNames.includes(eventName)) throw new Error(`No "${eventName}" event found on object "${objId}".`);

                let proxyFunc = removeListenerFunctions.get(eventName);
                if (!proxyFunc) {
                    const descr = { ...getEventDescriptor(descriptor, eventName), name: 'remove_' + eventName };
                    proxyFunc = <AnyFunction>_this.createProxyFunction(objId, descr, 'method_call');
                    removeListenerFunctions.set(eventName, proxyFunc);
                }
                proxyFunc(listener);
            };
        }

        obj[proxyObjectId] = objId;

        return obj;
    }

    private registerLocalObj(obj: any, descriptor: ObjectDescriptor): string {
        let objId = obj[hostObjectId];
        if (!this.hostObjectRegistry.has(objId)) {
            objId = this.objectIdGenerator();
            this.hostObjectRegistry.set(objId, { target: obj, descriptor });
            obj[hostObjectId] = objId;
        }
        return objId;
    }
    private registerLocalFunc(obj: any, descriptor: FunctionDescriptor): string {
        let objId = obj[hostObjectId];
        if (!this.hostFunctionRegistry.has(objId)) {
            objId = this.objectIdGenerator();
            this.hostFunctionRegistry.set(objId, { target: obj, descriptor });
            obj[hostObjectId] = objId;
        }
        return objId;
    }

    private processBeforeSerialization(obj: any, replyChannel: RPCChannel, descriptor?: Descriptor) {
        if (obj?.[proxyObjectId]) {
            return { _rpc_type: 'hostObject', objId: obj[proxyObjectId] };
        }

        switch (typeof obj) {
            case 'object': {
                if (!obj) break;

                // special case for Promise
                if (obj.constructor === Promise) {
                    if (!this.hostObjectRegistry.has((obj as any)[hostObjectId])) {
                        let result: unknown;
                        let success: boolean;
                        obj.then(
                            (value) => { result = value; success = true; },
                            (value) => { result = value; success = false; }
                        ).finally(() => this.sendAsyncIfPossible({ action: 'fn_reply', callType: 'async', success, result, callId: objId }, replyChannel));
                    }
                    const objId = this.registerLocalObj(obj, {});
                    return { _rpc_type: 'object', objId, classId: 'Promise' };
                }

                const entry = this.hostClassRegistry.get(obj.constructor?.[classIdSym]);
                if (entry) {
                    const objId = this.registerLocalObj(obj, entry.descriptor.instance ?? {});
                    const props: any = {};

                    for (const prop of entry.descriptor.instance?.readonlyProperties ?? []) {
                        const propName = getPropName(prop);
                        props[propName] = this.processBeforeSerialization(obj[propName], replyChannel);
                    }

                    return { _rpc_type: 'object', classId: entry.descriptor.classId, props, objId };
                }

                for (const key of Object.keys(obj)) {
                    obj[key] = this.processBeforeSerialization(obj[key], replyChannel);
                }
                break;
            }
            case 'function': {
                const objId = this.registerLocalFunc(obj, descriptor as FunctionDescriptor);
                return { _rpc_type: 'function', objId };
            }
        }
        return obj;
    }

    private processAfterDeserialization(obj: any, replyChannel: RPCChannel, descriptor?: Descriptor) {
        if (typeof obj !== 'object' || !obj) return obj;

        switch (obj._rpc_type) {
            case 'object': {
                return this.getOrCreateProxyInstance(obj.objId, obj.classId, obj.props, replyChannel);
            }
            case 'function': {
                return this.getOrCreateProxyFunction(obj.objId, replyChannel, descriptor as FunctionDescriptor);
            }
            case 'hostObject': {
                return this.hostObjectRegistry.get(obj.objId)?.target;
            }
        }

        for (const key of Object.keys(obj)) {
            obj[key] = this.processAfterDeserialization(obj[key], replyChannel, getPropertyDescriptor(descriptor as ObjectDescriptor, key));
        }

        return obj;
    }

    private sendObjectDied(objId: string, replyChannel = this.channel) {
        this.sendAsyncIfPossible({ action: 'obj_died', objId }, replyChannel);
    }

    private getOrCreateProxyInstance(objId: string, classId: string, props: any, replyChannel: RPCChannel) {
        let obj = this.proxyObjectRegistry.get(objId);
        if (obj) return obj;

        obj = props ?? {};

        // special case for Promise
        if (classId === 'Promise') {
            obj = new Promise((resolve, reject) => this.asyncCallbacks.set(objId, { resolve, reject }));
        } else {
            obj[proxyObjectId] = objId;
            const clazz = this.getProxyClass(classId);
            Object.setPrototypeOf(obj, clazz.prototype);
        }

        this.proxyObjectRegistry.register(objId, obj, () => this.sendObjectDied(objId, replyChannel));
        return obj;
    }

    private getOrCreateProxyFunction(objId: string, replyChannel: RPCChannel, descriptor?: FunctionDescriptor) {
        let fn = this.proxyObjectRegistry.get(objId);
        if (fn) return fn;

        if (descriptor) descriptor.type = 'function';
        fn = this.createProxyFunction(objId, <any>descriptor, 'fn_call', 'async', replyChannel);
        fn[proxyObjectId] = objId;
        this.proxyObjectRegistry.register(objId, fn, () => this.sendObjectDied(objId, replyChannel));

        return fn;
    }

}
