'use strict';

import { IAggregateSnapshotStorage, Identifier, IEvent } from "../interfaces";

/**
 * In-memory storage for aggregate snapshots.
 * Storage content resets on app restart
 */
export default class InMemorySnapshotStorage implements IAggregateSnapshotStorage {

	#snapshots: Map<Identifier, IEvent> = new Map();

	/**
	 * Get latest aggregate snapshot
	 */
	async getAggregateSnapshot(aggregateId: Identifier): Promise<IEvent | undefined> {
		return this.#snapshots.get(aggregateId);
	}

	/**
	 * Save new aggregate snapshot
	 */
	async saveAggregateSnapshot(snapshotEvent: IEvent) {
		if (!snapshotEvent.aggregateId)
			throw new TypeError('event.aggregateId is required');

		this.#snapshots.set(snapshotEvent.aggregateId, snapshotEvent);
	}
}
