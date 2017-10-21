declare type Identifier = string | number;

declare interface IMessage {
	type: string;
	aggregateId?: Identifier;
	aggregateVersion?: number;
	sagaId?: Identifier;
	sagaVersion?: number;
	payload?: any;
	context?: any;
}

declare type ICommand = IMessage;
declare type IEvent = IMessage;
declare type IEventStream = ReadonlyArray<Readonly<IEvent>>;

// region Aggregate

declare interface IAggregateState {
	mutate?(event: IEvent): void;
}

declare interface IAggregate {
	readonly id: Identifier;
	readonly version: number;
	readonly changes: IEventStream;
	readonly state?: IAggregateState;

	handle(command: ICommand): any;
	mutate(event: IEvent): void;
	emit(eventType: string, payload?: any): void;
	emitRaw(IEvent): void;

	readonly snapshotVersion?: number;
	readonly shouldTakeSnapshot?: boolean;
	takeSnapshot?(): void;
	makeSnapshot?(): IEvent;
	restoreSnapshot?(snapshotEvent: IEvent): void;
}

declare interface IAggregateConstructor {
	new(options: { id: Identifier, events: IEventStream, state?: IAggregateState }): IAggregate;
	readonly handles: string[];
}

declare interface ICommandHandler extends IObserver {
	subscribe(commandBus: ICommandBus): void;
}

// endregion Aggregate

// region Saga

declare interface ISaga {
	readonly id: Identifier;
	readonly version: number;
	readonly uncommittedMessages: ICommand[];

	apply(event: IEvent): ICommand[];
	enqueue(commandType: string, aggregateId: Identifier, payload: any): void;
	enqueueRaw(command: ICommand): void;

	resetUncommittedMessages(): void;
	onError(err: Error, params: { event: IEvent, command: ICommand }): void;
}

declare interface ISagaConstructor {
	new(options: { id: Identifier, events: IEventStream }): ISaga;
	readonly handles: string[];
}

declare interface IEventReceptor extends IObserver { 
	subscribe(eventStore: IEventStore): void;
}

// endregion Saga

// region Projection

declare interface IProjection extends IObserver {
	readonly view: IProjectionView;
	subscribe(eventStore: IEventStore): void;
	project(event: IEvent, options?: { nowait: boolean }): Promise<void>;
}

declare type ViewUpdateCallback = function(any): any;

declare interface IProjectionView {
	readonly ready: boolean;

	has(key: Identifier): boolean;
	get(key: Identifier, options?: { nowait: boolean }): Promise<object>;
	create(key: Identifier, update: ViewUpdateCallback | any): Promise<void>;
	update(key: Identifier, update: ViewUpdateCallback): Promive<void>;
	updateEnforcingNew(key: Identifier, update: ViewUpdateCallback): Promise<void>;
	updateAll(filter: function(any): boolean, update: ViewUpdateCallback): Promise<void>;
	delete(key: Identifier): Promise<void>;
	deleteAll(filter: function(any): boolean): Promise<void>;
}

// endregion Projection

declare interface IEventStore extends IObservable {
	getNewId(): Promise<Identifier>;

	commit(events: IEvent[]): Promise<IEventStream>;

	getAllEvents(eventTypes: string[], filter?: EventFilter): Promise<IEventStream>;
	getAggregateEvents(aggregateId: Identifier): Promise<IEventStream>;
	getSagaEvents(sagaId: Identifier, filter: EventFilter): Promise<IEventStream>;

	once(messageType: string, handler?: IMessageHandler, filter?: function(IEvent): boolean):
		Promise<IEvent>;
}

declare interface ICommandBus extends IObservable {
	send(commandType: string, aggregateId: Identifier, options: { payload?: object, context?: object }):
		Promise<IEventStream>;
	sendRaw(ICommand):
		Promise<IEventStream>;
}

// region Observable / Observer

declare type IMessageHandler = (message: IMessage) => void;

declare interface IObservable {
	on(type: string, handler: IMessageHandler, options?: SubscriptionOptions): void;
}

declare interface IObserver {
	readonly handles?: string[];
	subscribe(obervable: IObservable, messageTypes?: string[], masterHandler?: IMessageHandler | string): void;
}

// endregion

// region infrastructure services

declare type EventFilter = { afterEvent?: IEvent; beforeEvent?: IEvent; };
declare type SubscriptionOptions = { queueName?: string };

declare interface IEventStorage {
	getNewId(): Identifier | Promise<Identifier>;
	commitEvents(events: IEvent[]): Promise<any>;
	getAggregateEvents(aggregateId: Identifier, options: { snapshot: IEvent }): Promise<IEventStream>;
	getSagaEvents(sagaId: Identifier, filter: EventFilter): Promise<IEventStream>;
	getEvents(eventTypes: string[], filter: EventFilter): Promise<IEventStream>;
}

declare interface IAggregateSnapshotStorage {
	getAggregateSnapshot(aggregateId: Identifier): Promise<IEvent>;
	saveAggregateSnapshot(IEvent): Promise<void>;
}

declare interface IMessageBus {
	on(messageType: string, handler: IMessageHandler, options?: SubscriptionOptions): void;
	off?(messageType: string, handler: IMessageHandler, options?: SubscriptionOptions): void;
	removeListener?(messageType: string, handler: IMessageHandler): void;
	send(command: ICommand): Promise<any>;
	publish(event: IEvent): Promise<any>;
}

// endregion