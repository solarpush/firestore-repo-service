/**
 * Internal constants shared between the worker, queue, schema mapper and
 * SQL adapters.
 */

/**
 * Name of the SQL column that stores the publish-time `version` of each
 * sync event. Used by the worker to discard out-of-order PubSub deliveries
 * (the MERGE only updates rows when the incoming version is strictly
 * greater than the stored one).
 *
 * Two underscores prefix avoids collisions with user-defined fields.
 */
export const SYNC_VERSION_COLUMN = "__sync_version";
