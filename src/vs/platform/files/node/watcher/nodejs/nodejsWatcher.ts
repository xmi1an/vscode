/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ThrottledDelayer } from 'vs/base/common/async';
import { parse, ParsedPattern } from 'vs/base/common/glob';
import { Disposable } from 'vs/base/common/lifecycle';
import { basename, join } from 'vs/base/common/path';
import { realpath } from 'vs/base/node/extpath';
import { SymlinkSupport } from 'vs/base/node/pfs';
import { CHANGE_BUFFER_DELAY, watchFile, watchFolder } from 'vs/base/node/watcher';
import { FileChangeType } from 'vs/platform/files/common/files';
import { IDiskFileChange, ILogMessage, coalesceEvents } from 'vs/platform/files/common/watcher';

export class NodeJSFileWatcher extends Disposable {

	private readonly fileChangesDelayer: ThrottledDelayer<void> = this._register(new ThrottledDelayer<void>(CHANGE_BUFFER_DELAY * 2 /* sync on delay from underlying library */));
	private fileChangesBuffer: IDiskFileChange[] = [];

	private isDisposed: boolean | undefined;
	private readonly excludePatterns = this.excludes.map(exclude => parse(exclude));

	constructor(
		private path: string,
		private excludes: string[],
		private onDidFilesChange: (changes: IDiskFileChange[]) => void,
		private onLogMessage: (msg: ILogMessage) => void,
		private verboseLogging: boolean
	) {
		super();

		this.startWatching();
	}

	setVerboseLogging(verboseLogging: boolean): void {
		this.verboseLogging = verboseLogging;
	}

	private async startWatching(): Promise<void> {
		try {
			const { stat, symbolicLink } = await SymlinkSupport.stat(this.path);

			if (this.isDisposed) {
				return;
			}

			let pathToWatch = this.path;
			if (symbolicLink) {
				try {
					pathToWatch = await realpath(pathToWatch);
				} catch (error) {
					this.error(error);

					if (symbolicLink.dangling) {
						return; // give up if symbolic link is dangling
					}
				}
			}

			this.trace(`Request to start watching: ${pathToWatch} (excludes: ${this.excludes}))}`);

			// Watch Folder
			if (stat.isDirectory()) {
				this._register(watchFolder(pathToWatch, (eventType, path) => {
					this.onFileChange({
						type: eventType === 'changed' ? FileChangeType.UPDATED : eventType === 'added' ? FileChangeType.ADDED : FileChangeType.DELETED,
						path: join(this.path, basename(path)) // ensure path is identical with what was passed in
					});
				}, error => this.error(error)));
			}

			// Watch File
			else {
				this._register(watchFile(pathToWatch, eventType => {
					this.onFileChange({
						type: eventType === 'changed' ? FileChangeType.UPDATED : FileChangeType.DELETED,
						path: this.path // ensure path is identical with what was passed in
					});
				}, error => this.error(error)));
			}
		} catch (error) {
			if (error.code !== 'ENOENT') {
				this.error(error);
			}
		}
	}

	private onFileChange(event: IDiskFileChange): void {

		// Logging
		if (this.verboseLogging) {
			this.trace(`${event.type === FileChangeType.ADDED ? '[ADDED]' : event.type === FileChangeType.DELETED ? '[DELETED]' : '[CHANGED]'} ${event.path}`);
		}

		// Add to buffer unless ignored
		if (!this.isPathIgnored(event.path, this.excludePatterns)) {
			this.fileChangesBuffer.push(event);
		} else {
			if (this.verboseLogging) {
				this.trace(` >> ignored ${event.path}`);
			}
		}

		// Handle emit through delayer to accommodate for bulk changes and thus reduce spam
		this.fileChangesDelayer.trigger(async () => {
			const fileChanges = this.fileChangesBuffer;
			this.fileChangesBuffer = [];

			// Event coalsecer
			const coalescedFileChanges = coalesceEvents(fileChanges);

			// Logging
			if (this.verboseLogging) {
				for (const event of coalescedFileChanges) {
					this.trace(`>> normalized ${event.type === FileChangeType.ADDED ? '[ADDED]' : event.type === FileChangeType.DELETED ? '[DELETED]' : '[CHANGED]'} ${event.path}`);
				}
			}

			// Fire
			if (coalescedFileChanges.length > 0) {
				this.onDidFilesChange(coalescedFileChanges);
			}
		});
	}

	private isPathIgnored(absolutePath: string, ignored: ParsedPattern[]): boolean {
		return ignored.some(ignore => ignore(absolutePath));
	}

	private error(error: string): void {
		if (!this.isDisposed) {
			this.onLogMessage({ type: 'error', message: `[File Watcher (node.js)] ${error}` });
		}
	}

	private trace(message: string): void {
		if (!this.isDisposed && this.verboseLogging) {
			this.onLogMessage({ type: 'trace', message: `[File Watcher (node.js)] ${message}` });
		}
	}

	override dispose(): void {
		this.isDisposed = true;

		super.dispose();
	}
}
