/*---------------------------------------------------------------------------------------------
 *  Type stub for kuzu (embedded graph database).
 *  Minimal declarations needed by src/insrc/.
 *--------------------------------------------------------------------------------------------*/

declare module 'kuzu' {
	export type KuzuValue = null | boolean | number | bigint | string | Date | Record<string, unknown> | KuzuValue[];

	export class Database {
		constructor(databasePath?: string, bufferManagerSize?: number, enableCompression?: boolean, readOnly?: boolean, maxDBSize?: number);
		init(): Promise<void>;
		close(): Promise<void>;
	}

	export class PreparedStatement {
		isSuccess(): boolean;
		getErrorMessage(): string;
	}

	export class Connection {
		constructor(database: Database, numThreads?: number);
		init(): Promise<void>;
		close(): Promise<void>;
		query(statement: string): Promise<QueryResult | QueryResult[]>;
		prepare(statement: string): Promise<PreparedStatement>;
		execute(preparedStatement: PreparedStatement, params?: Record<string, KuzuValue>): Promise<QueryResult | QueryResult[]>;
	}

	export class QueryResult {
		resetIterator(): void;
		hasNext(): boolean;
		getNumTuples(): number;
		getAll(): Promise<Record<string, KuzuValue>[]>;
		close(): void;
	}

	// Default export + namespace for `kuzu.Database` / `kuzu.Connection` usage
	namespace kuzu {
		export { Database, Connection, QueryResult, KuzuValue };
	}

	export default kuzu;
}
