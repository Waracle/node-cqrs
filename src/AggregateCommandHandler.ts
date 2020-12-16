'use strict';

import {
	IAggregate,
	IAggregateConstructor,
	IAggregateFactory,
	ICommand,
	ICommandBus,
	ICommandHandler,
	Identifier,
	IEventStore,
	IEventStream,
	ILogger,
	ISnapshotStorage
} from "./interfaces";


import { getClassName, isClass, getHandledMessageTypes, readEventsFromIterator } from './utils';
import subscribe from './subscribe';

const asAggregateConstructor = (type: any): IAggregateConstructor<any> | undefined =>
	(isClass(type) ? type : undefined);

/**
 * Aggregate command handler.
 *
 * Subscribes to event store and awaits aggregate commands.
 * Upon command receiving creates an instance of aggregate,
 * restores its state, passes command and commits emitted events to event store.
 */
export default class AggregateCommandHandler implements ICommandHandler {

	#eventStore: IEventStore;
	#snapshotStorage?: ISnapshotStorage;
	#logger?: ILogger;

	#aggregateFactory: IAggregateFactory<any>;
	#handles: string[];

	/**
	 * Creates an instance of AggregateCommandHandler.
	 *
	 * @param {object} options
	 * @param {IEventStore} options.eventStore
	 * @param {ISnapshotStorage} [options.snapshotStorage]
	 * @param {IAggregateConstructor | IAggregateFactory} options.aggregateType
	 * @param {string[]} [options.handles]
	 * @param {ILogger} [options.logger]
	 */
	constructor({
		eventStore,
		snapshotStorage,
		aggregateType,
		handles,
		logger
	}: {
		eventStore: IEventStore,
		snapshotStorage?: ISnapshotStorage,
		aggregateType: IAggregateConstructor<any> | IAggregateFactory<any>,
		handles?: string[],
		logger?: ILogger
	}) {
		if (!eventStore) throw new TypeError('eventStore argument required');
		if (!aggregateType) throw new TypeError('aggregateType argument required');

		this.#eventStore = eventStore;
		this.#logger = logger;
		this.#snapshotStorage = snapshotStorage;

		const AggregateType = asAggregateConstructor(aggregateType);
		if (AggregateType) {
			this.#aggregateFactory = params => new AggregateType(params);
			this.#handles = getHandledMessageTypes(AggregateType);
		}
		else {
			if (!Array.isArray(handles) || !handles.length)
				throw new TypeError('handles argument must be an non-empty Array');

			this.#aggregateFactory = aggregateType as IAggregateFactory<any>;
			this.#handles = handles;
		}
	}

	/**
	 * Subscribe to all command types handled by aggregateType
	 */
	subscribe(commandBus: ICommandBus) {
		subscribe(commandBus, this, {
			messageTypes: this.#handles,
			masterHandler: (c: ICommand) => this.execute(c)
		});
	}

	/**
	 * Restore aggregate from event store events
	 */
	private async _restoreAggregate(id: Identifier): Promise<IAggregate> {
		const snapshot = this.#snapshotStorage ? await this.#snapshotStorage.getSnapshot(id) : undefined;
		const eventsFilter = snapshot && { afterEvent: snapshot.lastEvent };
		const events = await readEventsFromIterator(await this.#eventStore.getStream(id, eventsFilter));

		const aggregate = this.#aggregateFactory({ id, snapshot, events });

		this.#logger?.log('info', `${aggregate} state restored from ${events}`, { service: getClassName(aggregate) });

		return aggregate;
	}

	/**
	 * Create new aggregate with new Id generated by event store
	 */
	private async _createAggregate(): Promise<IAggregate> {
		const id = await this.#eventStore.getNewId();
		const aggregate = this.#aggregateFactory({ id });
		this.#logger?.log('info', `${aggregate} created`, { service: getClassName(aggregate) });

		return aggregate;
	}

	/**
	 * Pass a command to corresponding aggregate
	 */
	async execute(cmd: ICommand): Promise<IEventStream> {
		if (!cmd) throw new TypeError('cmd argument required');
		if (!cmd.type) throw new TypeError('cmd.type argument required');

		const aggregate = cmd.aggregateId ?
			await this._restoreAggregate(cmd.aggregateId) :
			await this._createAggregate();

		const handlerResponse = aggregate.handle(cmd);
		if (handlerResponse instanceof Promise)
			await handlerResponse;

		const events = aggregate.changes;
		this.#logger?.log('info', `${aggregate} "${cmd.type}" command processed, ${events} produced`, { service: getClassName(aggregate) });
		if (!events.length)
			return events;

		await this.#eventStore.commit(aggregate.id, events);

		if (this.#snapshotStorage && aggregate.shouldTakeSnapshot) {
			if (typeof aggregate.makeSnapshot !== 'function')
				throw new TypeError('aggregate.makeSnapshot must be a Function');

			const snapshot = aggregate.makeSnapshot();

			this.#snapshotStorage.saveSnapshot(aggregate.id, snapshot);
		}

		return events;
	}
}
