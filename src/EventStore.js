'use strict';

const InMemoryBus = require('./infrastructure/InMemoryMessageBus');
const nullLogger = require('./utils/nullLogger');
const EventStream = require('./EventStream');

const SNAPSHOT_EVENT_TYPE = 'snapshot';
const service = 'EventStore';

const _defaults = {
	publishAsync: true
};

/**
 * Validate event structure
 *
 * @param {IEvent} event
 */
function validateEvent(event) {
	if (typeof event !== 'object' || !event) throw new TypeError('event must be an Object');
	if (typeof event.type !== 'string' || !event.type.length) throw new TypeError('event.type must be a non-empty String');
	if (!event.aggregateId && !event.sagaId) throw new TypeError('either event.aggregateId or event.sagaId is required');
	if (event.sagaId && typeof event.sagaVersion === 'undefined') throw new TypeError('event.sagaVersion is required, when event.sagaId is defined');
}

/**
 * Ensure provided eventStorage matches the expected format
 * @param {IEventStorage} storage
 */
function validateEventStorage(storage) {
	if (!storage) throw new TypeError('storage argument required');
	if (typeof storage !== 'object') throw new TypeError('storage argument must be an Object');
	if (typeof storage.commitEvents !== 'function') throw new TypeError('storage.commitEvents must be a Function');
	if (typeof storage.getEvents !== 'function') throw new TypeError('storage.getEvents must be a Function');
	if (typeof storage.getAggregateEvents !== 'function') throw new TypeError('storage.getAggregateEvents must be a Function');
	if (typeof storage.getSagaEvents !== 'function') throw new TypeError('storage.getSagaEvents must be a Function');
	if (typeof storage.getNewId !== 'function') throw new TypeError('storage.getNewId must be a Function');
}

/**
 * Check if storage emits events
 *
 * @param {object} storage
 * @returns {boolean}
 */
function isEmitter(storage) {
	return typeof storage.on === 'function';
}

/**
 * Ensure snapshotStorage matches the expected format
 * @param {IAggregateSnapshotStorage} snapshotStorage
 */
function validateSnapshotStorage(snapshotStorage) {
	if (typeof snapshotStorage !== 'object' || !snapshotStorage)
		throw new TypeError('snapshotStorage argument must be an Object');
	if (typeof snapshotStorage.getAggregateSnapshot !== 'function')
		throw new TypeError('snapshotStorage.getAggregateSnapshot argument must be a Function');
	if (typeof snapshotStorage.saveAggregateSnapshot !== 'function')
		throw new TypeError('snapshotStorage.saveAggregateSnapshot argument must be a Function');
}

/**
 * Ensure messageBus matches the expected format
 * @param {IMessageBus} messageBus
 */
function validateMessageBus(messageBus) {
	if (typeof messageBus !== 'object' || !messageBus)
		throw new TypeError('messageBus argument must be an Object');
	if (typeof messageBus.on !== 'function')
		throw new TypeError('messageBus.on argument must be a Function');
	if (typeof messageBus.publish !== 'function')
		throw new TypeError('messageBus.publish argument must be a Function');
}


/**
 * Create one-time eventEmitter subscription for one or multiple events that match a filter
 *
 * @param {IEventEmitter} emitter
 * @param {string[]} messageTypes Array of event type to subscribe to
 * @param {function(IEvent):any} [handler] Optional handler to execute for a first event received
 * @param {function(IEvent):boolean} [filter] Optional filter to apply before executing a handler
 * @param {ILogger} logger
 * @return {Promise<IEvent>} Resolves to first event that passes filter
 */
function setupOneTimeEmitterSubscription(emitter, messageTypes, filter, handler, logger) {
	if (typeof emitter !== 'object' || !emitter)
		throw new TypeError('emitter argument must be an Object');
	if (!Array.isArray(messageTypes) || messageTypes.some(m => !m || typeof m !== 'string'))
		throw new TypeError('messageTypes argument must be an Array of non-empty Strings');
	if (handler && typeof handler !== 'function')
		throw new TypeError('handler argument, when specified, must be a Function');
	if (filter && typeof filter !== 'function')
		throw new TypeError('filter argument, when specified, must be a Function');

	return new Promise(resolve => {

		// handler will be invoked only once,
		// even if multiple events have been emitted before subscription was destroyed
		// https://nodejs.org/api/events.html#events_emitter_removelistener_eventname_listener
		let handled = false;

		function filteredHandler(event) {
			if (filter && !filter(event)) return;
			if (handled) return;
			handled = true;

			for (const messageType of messageTypes)
				emitter.off(messageType, filteredHandler);

			if (logger)
				logger.log('debug', `'${event.type}' received, one-time subscription to '${messageTypes.join(',')}' removed`, { service });

			if (handler)
				handler(event);

			resolve(event);
		}

		for (const messageType of messageTypes)
			emitter.on(messageType, filteredHandler);

		if (logger)
			logger.log('debug', `set up one-time ${filter ? 'filtered subscription' : 'subscription'} to '${messageTypes.join(',')}'`, { service });
	});
}

/**
 * @typedef {object} EventStoreConfig
 * @property {boolean} [publishAsync]
 */

/**
 * @class EventStore
 * @implements {IEventStore}
 */
class EventStore {

	/**
	 * Default configuration
	 *
	 * @type {EventStoreConfig}
	 * @static
	 */
	static get defaults() {
		return _defaults;
	}

	/**
	 * Configuration
	 *
	 * @type {EventStoreConfig}
	 * @readonly
	 */
	get config() {
		return this._config;
	}

	/**
	 * Whether storage supports aggregate snapshots
	 *
	 * @type {boolean}
	 * @readonly
	 */
	get snapshotsSupported() {
		return Boolean(this._snapshotStorage);
	}

	/**
	 * Creates an instance of EventStore.
	 *
	 * @param {object} options
	 * @param {IEventStorage} options.storage
	 * @param {IAggregateSnapshotStorage} [options.snapshotStorage]
	 * @param {IMessageBus} [options.messageBus]
	 * @param {function(IEvent):void} [options.eventValidator]
	 * @param {EventStoreConfig} [options.eventStoreConfig]
	 * @param {ILogger} [options.logger]
	 */
	constructor(options) {
		validateEventStorage(options.storage);
		if (options.snapshotStorage)
			validateSnapshotStorage(options.snapshotStorage);
		if (options.messageBus)
			validateMessageBus(options.messageBus);
		if (options.eventValidator !== undefined && typeof options.eventValidator !== 'function')
			throw new TypeError('eventValidator, when provided, must be a function');

		this._config = Object.freeze(Object.assign({}, EventStore.defaults, options.eventStoreConfig));
		this._storage = options.storage;
		this._snapshotStorage = options.snapshotStorage;
		this._validator = options.eventValidator || validateEvent;
		this._logger = options.logger || nullLogger;

		/** @type {string[]} */
		this._sagaStarters = [];

		if (options.messageBus) {
			this._publishTo = options.messageBus;
			this._eventEmitter = options.messageBus;
		}
		else if (isEmitter(options.storage)) {
			/** @type {IEventEmitter} */
			this._eventEmitter = options.storage;
		}
		else {
			const internalMessageBus = new InMemoryBus();
			this._publishTo = internalMessageBus;
			this._eventEmitter = internalMessageBus;
		}
	}

	/**
	 * Retrieve new ID from the storage
	 *
	 * @returns {Promise<Identifier>}
	 */
	async getNewId() {
		return this._storage.getNewId();
	}

	/**
	 * Retrieve all events of specific types
	 *
	 * @param {string[]} eventTypes
	 * @returns {AsyncIterableIterator<IEvent>}
	 */
	async* getAllEvents(eventTypes) {
		if (eventTypes && !Array.isArray(eventTypes)) throw new TypeError('eventTypes, if specified, must be an Array');

		this._logger.log('debug', `retrieving ${eventTypes ? eventTypes.join(', ') : 'all'} events...`, { service });

		const eventsIterable = await this._storage.getEvents(eventTypes);

		yield* eventsIterable;

		this._logger.log('debug', `${eventTypes ? eventTypes.join(', ') : 'all'} events retrieved`, { service });
	}

	/**
	 * Retrieve all events of specific Aggregate
	 *
	 * @param {Identifier} aggregateId
	 * @returns {Promise<IEventStream>}
	 */
	async getAggregateEvents(aggregateId) {
		if (!aggregateId) throw new TypeError('aggregateId argument required');

		this._logger.log('debug', `retrieving event stream for aggregate ${aggregateId}...`, { service });

		const snapshot = this.snapshotsSupported ?
			await this._snapshotStorage.getAggregateSnapshot(aggregateId) :
			undefined;

		const events = [];
		if (snapshot)
			events.push(snapshot);

		const eventsIterable = await this._storage.getAggregateEvents(aggregateId, { snapshot });
		for await (const event of eventsIterable)
			events.push(event);

		const eventStream = new EventStream(events);
		this._logger.log('debug', `${eventStream} retrieved`, { service });

		return eventStream;
	}

	/**
	 * Retrieve events of specific Saga
	 *
	 * @param {Identifier} sagaId
	 * @param {object} filter
	 * @param {IEvent} filter.beforeEvent
	 * @returns {Promise<IEventStream>}
	 */
	async getSagaEvents(sagaId, filter) {
		if (!sagaId) throw new TypeError('sagaId argument required');
		if (!filter) throw new TypeError('filter argument required');
		if (!filter.beforeEvent) throw new TypeError('filter.beforeEvent argument required');
		if (filter.beforeEvent.sagaVersion === undefined) throw new TypeError('filter.beforeEvent.sagaVersion argument required');

		this._logger.log('debug', `retrieving event stream for saga ${sagaId}, v${filter.beforeEvent.sagaVersion}...`, { service });

		const events = [];
		const eventsIterable = await this._storage.getSagaEvents(sagaId, filter);
		for await (const event of eventsIterable)
			events.push(event);

		const eventStream = new EventStream(events);
		this._logger.log('debug', `${eventStream.toString()} retrieved`, { service });

		return eventStream;
	}

	/**
	 * Register event types that start sagas.
	 * Upon such event commit a new sagaId will be assigned
	 *
	 * @param {string[]} eventTypes
	 * @memberof EventStore
	 */
	registerSagaStarters(eventTypes = []) {
		const uniqueEventTypes = eventTypes.filter(e => !this._sagaStarters.includes(e));
		this._sagaStarters.push(...uniqueEventTypes);
	}

	/**
	 * Validate events, commit to storage and publish to messageBus, if needed
	 *
	 * @param {IEventStream} events - a set of events to commit
	 * @returns {Promise<IEventStream>} - resolves to signed and committed events
	 */
	async commit(events) {
		if (!Array.isArray(events)) throw new TypeError('events argument must be an Array');

		const containsSagaStarters = this._sagaStarters.length && events.some(e => this._sagaStarters.includes(e.type));
		const augmentedEvents = containsSagaStarters ?
			await this._attachSagaIdToSagaStarterEvents(events) :
			events;

		const eventStreamWithoutSnapshots = await this.save(augmentedEvents);

		// after events are saved to the persistent storage,
		// publish them to the event bus (i.e. RabbitMq)
		if (this._publishTo)
			await this.publish(eventStreamWithoutSnapshots);

		return eventStreamWithoutSnapshots;
	}

	/**
	 * Generate and attach sagaId to events that start new sagas
	 *
	 * @param {IEventStream} events
	 * @returns {Promise<IEventStream>}
	 * @memberof EventStore
	 * @private
	 */
	async _attachSagaIdToSagaStarterEvents(events) {
		const r = [];
		for (const event of events) {
			if (this._sagaStarters.includes(event.type)) {
				if (event.sagaId)
					throw new Error(`Event "${event.type}" already contains sagaId. Multiple sagas with same event type are not supported`);

				r.push(Object.assign({
					sagaId: await this.getNewId(),
					sagaVersion: 0
				}, event));
			}
			else {
				r.push(event);
			}
		}
		return new EventStream(r);
	}

	/**
	 * Save events to the persistent storage(s)
	 *
	 * @param {IEventStream} events Event stream that may include snapshot events
	 * @returns {Promise<IEventStream>} Event stream without snapshot events
	 */
	async save(events) {
		if (!Array.isArray(events)) throw new TypeError('events argument must be an Array');

		const snapshotEvents = events.filter(e => e.type === SNAPSHOT_EVENT_TYPE);
		if (snapshotEvents.length > 1)
			throw new Error(`cannot commit a stream with more than 1 ${SNAPSHOT_EVENT_TYPE} event`);
		if (snapshotEvents.length && !this.snapshotsSupported)
			throw new Error(`${SNAPSHOT_EVENT_TYPE} event type is not supported by the storage`);

		const snapshot = snapshotEvents[0];
		const eventStream = new EventStream(events.filter(e => e !== snapshot));

		this._logger.log('debug', `validating ${eventStream}...`, { service });
		eventStream.forEach(this._validator);

		this._logger.log('debug', `saving ${eventStream}...`, { service });
		await Promise.all([
			this._storage.commitEvents(eventStream),
			snapshot ?
				this._snapshotStorage.saveAggregateSnapshot(snapshot) :
				undefined
		]);

		return eventStream;
	}

	/**
	 * After events are
	 * @param {IEventStream} eventStream
	 */
	async publish(eventStream) {
		const publishEvents = () =>
			Promise.all(eventStream.map(event => this._publishTo.publish(event)))
				.then(() => {
					this._logger.log('debug', `${eventStream} published`, { service });
				}, error => {
					this._logger.log('error', `${eventStream} publishing failed: ${error.message}`, { service, stack: error.stack });
					throw error;
				});

		if (this.config.publishAsync) {
			this._logger.log('debug', `publishing ${eventStream} asynchronously...`, { service });
			setImmediate(publishEvents);
		}
		else {
			this._logger.log('debug', `publishing ${eventStream} synchronously...`, { service });
			await publishEvents();
		}
	}

	/**
	 * Setup a listener for a specific event type
	 *
	 * @param {string} messageType
	 * @param {function(IEvent): any} handler
	 */
	on(messageType, handler) {
		if (typeof messageType !== 'string' || !messageType.length) throw new TypeError('messageType argument must be a non-empty String');
		if (typeof handler !== 'function') throw new TypeError('handler argument must be a Function');
		if (arguments.length !== 2) throw new TypeError(`2 arguments are expected, but ${arguments.length} received`);

		this._eventEmitter.on(messageType, handler);
	}

	/**
	 * Get or create a named queue, which delivers events to a single handler only
	 *
	 * @param {string} name
	 */
	queue(name) {
		if (typeof this._eventEmitter.queue !== 'function')
			throw new Error('Named queues are not supported by the underlying message bus');

		return this._eventEmitter.queue(name);
	}

	/**
	 * Creates one-time subscription for one or multiple events that match a filter
	 *
	 * @param {string|string[]} messageTypes - Array of event type to subscribe to
	 * @param {function(IEvent):any} [handler] - Optional handler to execute for a first event received
	 * @param {function(IEvent):boolean} [filter] - Optional filter to apply before executing a handler
	 * @return {Promise<IEvent>} Resolves to first event that passes filter
	 */
	once(messageTypes, handler, filter) {
		const subscribeTo = Array.isArray(messageTypes) ? messageTypes : [messageTypes];

		return setupOneTimeEmitterSubscription(this._eventEmitter, subscribeTo, filter, handler);
	}
}

module.exports = EventStore;
