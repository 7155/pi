export type JsonlRecordWrite = (record: string, callback: (error?: Error | null) => void) => boolean | undefined;

/** Keep the shared Runtime event/response channel record-atomic under load. */
export class SerializedJsonlOutput {
	private readonly write: JsonlRecordWrite;
	private tail: Promise<void> = Promise.resolve();

	constructor(write: JsonlRecordWrite) {
		this.write = write;
	}

	emit(value: unknown): void {
		this.tail = this.tail.then(
			() =>
				new Promise<void>((resolve, reject) => {
					try {
						const record = `${JSON.stringify(value)}\n`;
						this.write(record, (error) => {
							if (error) reject(error);
							else resolve();
						});
					} catch (error) {
						reject(error instanceof Error ? error : new Error(String(error)));
					}
				}),
		);
		// The CLI awaits the same tail at shutdown. Attach a handler now so a
		// broken pipe cannot become an unhandled rejection in the meantime.
		void this.tail.catch(() => {});
	}

	async settle(): Promise<void> {
		await this.tail;
	}
}
