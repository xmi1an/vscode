/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { assertIsDefined, withNullAsUndefined } from 'vs/base/common/types';
import { ICodeEditor, getCodeEditor, IPasteEvent } from 'vs/editor/browser/editorBrowser';
import { IEditorOpenContext } from 'vs/workbench/common/editor';
import { EditorInput } from 'vs/workbench/common/editor/editorInput';
import { applyTextEditorOptions } from 'vs/workbench/common/editor/editorOptions';
import { AbstractTextResourceEditorInput, TextResourceEditorInput } from 'vs/workbench/common/editor/textResourceEditorInput';
import { BaseTextEditorModel } from 'vs/workbench/common/editor/textEditorModel';
import { UntitledTextEditorInput } from 'vs/workbench/services/untitled/common/untitledTextEditorInput';
import { BaseTextEditor } from 'vs/workbench/browser/parts/editor/textEditor';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { ITextResourceConfigurationService } from 'vs/editor/common/services/textResourceConfiguration';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { ScrollType, IEditor, ICodeEditorViewState } from 'vs/editor/common/editorCommon';
import { IEditorGroupsService } from 'vs/workbench/services/editor/common/editorGroupsService';
import { CancellationToken } from 'vs/base/common/cancellation';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IModelService } from 'vs/editor/common/services/model';
import { ILanguageService } from 'vs/editor/common/services/language';
import { PLAINTEXT_LANGUAGE_ID } from 'vs/editor/common/modes/modesRegistry';
import { EditorOption, IEditorOptions as ICodeEditorOptions } from 'vs/editor/common/config/editorOptions';
import { ModelConstants } from 'vs/editor/common/model';
import { ITextEditorOptions } from 'vs/platform/editor/common/editor';

/**
 * An editor implementation that is capable of showing the contents of resource inputs. Uses
 * the TextEditor widget to show the contents.
 */
export class AbstractTextResourceEditor extends BaseTextEditor<ICodeEditorViewState> {

	constructor(
		id: string,
		@ITelemetryService telemetryService: ITelemetryService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IStorageService storageService: IStorageService,
		@ITextResourceConfigurationService textResourceConfigurationService: ITextResourceConfigurationService,
		@IThemeService themeService: IThemeService,
		@IEditorGroupsService editorGroupService: IEditorGroupsService,
		@IEditorService editorService: IEditorService
	) {
		super(id, telemetryService, instantiationService, storageService, textResourceConfigurationService, themeService, editorService, editorGroupService);
	}

	override getTitle(): string | undefined {
		if (this.input) {
			return this.input.getName();
		}

		return localize('textEditor', "Text Editor");
	}

	override async setInput(input: AbstractTextResourceEditorInput, options: ITextEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {

		// Set input and resolve
		await super.setInput(input, options, context, token);
		const resolvedModel = await input.resolve();

		// Check for cancellation
		if (token.isCancellationRequested) {
			return undefined;
		}

		// Assert Model instance
		if (!(resolvedModel instanceof BaseTextEditorModel)) {
			throw new Error('Unable to open file as text');
		}

		// Set Editor Model
		const textEditor = assertIsDefined(this.getControl());
		const textEditorModel = resolvedModel.textEditorModel;
		textEditor.setModel(textEditorModel);

		// Apply options to editor if any
		let optionsGotApplied = false;
		if (options) {
			optionsGotApplied = applyTextEditorOptions(options, textEditor, ScrollType.Immediate);
		}

		// Otherwise restore View State unless disabled via settings
		if (!optionsGotApplied) {
			this.restoreTextResourceEditorViewState(input, context, textEditor);
		}

		// Since the resolved model provides information about being readonly
		// or not, we apply it here to the editor even though the editor input
		// was already asked for being readonly or not. The rationale is that
		// a resolved model might have more specific information about being
		// readonly or not that the input did not have.
		textEditor.updateOptions({ readOnly: resolvedModel.isReadonly() });
	}

	private restoreTextResourceEditorViewState(editor: AbstractTextResourceEditorInput, context: IEditorOpenContext, control: IEditor) {
		const viewState = this.loadEditorViewState(editor, context);
		if (viewState) {
			control.restoreViewState(viewState);
		}
	}

	/**
	 * Reveals the last line of this editor if it has a model set.
	 */
	revealLastLine(): void {
		const codeEditor = <ICodeEditor>this.getControl();
		const model = codeEditor.getModel();

		if (model) {
			const lastLine = model.getLineCount();
			codeEditor.revealPosition({ lineNumber: lastLine, column: model.getLineMaxColumn(lastLine) }, ScrollType.Smooth);
		}
	}

	override clearInput(): void {
		super.clearInput();

		// Clear Model
		const textEditor = this.getControl();
		if (textEditor) {
			textEditor.setModel(null);
		}
	}

	protected override tracksEditorViewState(input: EditorInput): boolean {
		// editor view state persistence is only enabled for untitled and resource inputs
		return input instanceof UntitledTextEditorInput || input instanceof TextResourceEditorInput;
	}
}

export class TextResourceEditor extends AbstractTextResourceEditor {

	static readonly ID = 'workbench.editors.textResourceEditor';

	constructor(
		@ITelemetryService telemetryService: ITelemetryService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IStorageService storageService: IStorageService,
		@ITextResourceConfigurationService textResourceConfigurationService: ITextResourceConfigurationService,
		@IThemeService themeService: IThemeService,
		@IEditorService editorService: IEditorService,
		@IEditorGroupsService editorGroupService: IEditorGroupsService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService
	) {
		super(TextResourceEditor.ID, telemetryService, instantiationService, storageService, textResourceConfigurationService, themeService, editorGroupService, editorService);
	}

	protected override createEditorControl(parent: HTMLElement, configuration: ICodeEditorOptions): IEditor {
		const control = super.createEditorControl(parent, configuration);

		// Install a listener for paste to update this editors
		// language mode if the paste includes a specific mode
		const codeEditor = getCodeEditor(control);
		if (codeEditor) {
			this._register(codeEditor.onDidPaste(e => this.onDidEditorPaste(e, codeEditor)));
		}

		return control;
	}

	private onDidEditorPaste(e: IPasteEvent, codeEditor: ICodeEditor): void {
		if (this.input instanceof UntitledTextEditorInput && this.input.model.hasModeSetExplicitly) {
			return; // do not override mode if it was set explicitly
		}

		if (e.range.startLineNumber !== 1 || e.range.startColumn !== 1) {
			return; // only when pasting into first line, first column (= empty document)
		}

		if (codeEditor.getOption(EditorOption.readOnly)) {
			return; // not for readonly editors
		}

		const textModel = codeEditor.getModel();
		if (!textModel) {
			return; // require a live model
		}

		const currentLanguageId = textModel.getLanguageId();
		if (currentLanguageId !== PLAINTEXT_LANGUAGE_ID) {
			return; // require current languageId to be unspecific
		}

		let candidateLanguageId: string | undefined = undefined;

		// A languageId is provided via the paste event so text was copied using
		// VSCode. As such we trust this languageId and use it if specific
		if (e.languageId) {
			candidateLanguageId = e.languageId;
		}

		// A languageId was not provided, so the data comes from outside VSCode
		// We can still try to guess a good languageId from the first line if
		// the paste changed the first line
		else {
			candidateLanguageId = withNullAsUndefined(this.languageService.guessLanguageIdByFilepathOrFirstLine(textModel.uri, textModel.getLineContent(1).substr(0, ModelConstants.FIRST_LINE_DETECTION_LENGTH_LIMIT)));
		}

		// Finally apply languageId to model if specified
		if (candidateLanguageId !== PLAINTEXT_LANGUAGE_ID) {
			this.modelService.setMode(textModel, this.languageService.createById(candidateLanguageId));
		}
	}
}
