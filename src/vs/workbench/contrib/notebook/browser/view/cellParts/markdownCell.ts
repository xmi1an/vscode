/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from 'vs/base/browser/dom';
import { disposableTimeout, raceCancellation } from 'vs/base/common/async';
import { CancellationTokenSource } from 'vs/base/common/cancellation';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { CodeEditorWidget } from 'vs/editor/browser/widget/codeEditorWidget';
import { IEditorOptions } from 'vs/editor/common/config/editorOptions';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { CellEditState, CellFocusMode, ICellViewModel, IActiveNotebookEditorDelegate } from 'vs/workbench/contrib/notebook/browser/notebookBrowser';
import { CellFoldingState } from 'vs/workbench/contrib/notebook/browser/contrib/fold/foldingModel';
import { MarkupCellViewModel } from 'vs/workbench/contrib/notebook/browser/viewModel/markupCellViewModel';
import { ICodeEditor } from 'vs/editor/browser/editorBrowser';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { ServiceCollection } from 'vs/platform/instantiation/common/serviceCollection';
import { EditorContextKeys } from 'vs/editor/common/editorContextKeys';
import { INotebookCellStatusBarService } from 'vs/workbench/contrib/notebook/common/notebookCellStatusBarService';
import { collapsedIcon, expandedIcon } from 'vs/workbench/contrib/notebook/browser/notebookIcons';
import { renderIcon } from 'vs/base/browser/ui/iconLabel/iconLabels';
import { IReadonlyTextBuffer } from 'vs/editor/common/model';
import { tokenizeToStringSync } from 'vs/editor/common/modes/textToHtmlTokenizer';
import { MarkdownCellRenderTemplate } from 'vs/workbench/contrib/notebook/browser/view/notebookRenderingCommon';
import { ILanguageService } from 'vs/editor/common/services/language';
import { CellEditorOptions } from 'vs/workbench/contrib/notebook/browser/view/cellParts/cellEditorOptions';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { CellPart } from 'vs/workbench/contrib/notebook/browser/view/cellParts/cellPart';


export class StatefulMarkdownCell extends Disposable {

	private editor: CodeEditorWidget | null = null;

	private markdownAccessibilityContainer!: HTMLElement;
	private editorPart: HTMLElement;

	private readonly localDisposables = this._register(new DisposableStore());
	private readonly focusSwitchDisposable = this._register(new MutableDisposable());
	private readonly editorDisposables = this._register(new DisposableStore());
	private foldingState: CellFoldingState;
	private cellEditorOptions: CellEditorOptions;
	private editorOptions: IEditorOptions;

	constructor(
		private readonly notebookEditor: IActiveNotebookEditorDelegate,
		private readonly viewCell: MarkupCellViewModel,
		private readonly templateData: MarkdownCellRenderTemplate,
		private readonly cellParts: CellPart[],
		private readonly renderedEditors: Map<ICellViewModel, ICodeEditor | undefined>,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@INotebookCellStatusBarService readonly notebookCellStatusBarService: INotebookCellStatusBarService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IConfigurationService private configurationService: IConfigurationService,
	) {
		super();

		this.constructDOM();
		this.editorPart = templateData.editorPart;

		this.cellEditorOptions = this._register(new CellEditorOptions(this.notebookEditor, this.notebookEditor.notebookOptions, this.configurationService, this.viewCell.language));
		this.cellEditorOptions.setLineNumbers(this.viewCell.lineNumbers);
		this.editorOptions = this.cellEditorOptions.getValue(this.viewCell.internalMetadata, this.viewCell.uri);

		this._register(toDisposable(() => renderedEditors.delete(this.viewCell)));
		this.registerListeners();

		// update for init state
		this.cellParts.forEach(cellPart => {
			cellPart.renderCell(this.viewCell, this.templateData);
		});

		this.updateForHover();
		this.updateForFocusModeChange();
		this.foldingState = viewCell.foldingState;
		this.setFoldingIndicator();
		this.updateFoldingIconShowClass();

		// the markdown preview's height might already be updated after the renderer calls `element.getHeight()`
		if (this.viewCell.layoutInfo.totalHeight > 0) {
			this.relayoutCell();
		}

		this.applyDecorations();
		this.viewUpdate();

		this.layoutCellParts();
		this._register(this.viewCell.onDidChangeLayout(() => {
			this.layoutCellParts();
		}));
	}

	layoutCellParts() {
		this.cellParts.forEach(part => {
			part.updateInternalLayoutNow(this.viewCell);
		});
	}

	private constructDOM() {
		// Create an element that is only used to announce markup cell content to screen readers
		const id = `aria-markup-cell-${this.viewCell.id}`;
		this.markdownAccessibilityContainer = this.templateData.cellContainer;
		this.markdownAccessibilityContainer.id = id;
		// Hide the element from non-screen readers
		this.markdownAccessibilityContainer.style.height = '1px';
		this.markdownAccessibilityContainer.style.position = 'absolute';
		this.markdownAccessibilityContainer.style.top = '10000px';
		this.markdownAccessibilityContainer.ariaHidden = 'false';

		this.templateData.rootContainer.setAttribute('aria-describedby', id);
		this.templateData.container.classList.toggle('webview-backed-markdown-cell', true);
	}

	private registerListeners() {
		this._register(this.viewCell.onDidChangeState(e => {
			this.cellParts.forEach(cellPart => {
				cellPart.updateState(this.viewCell, e);
			});
		}));

		this._register(this.viewCell.model.onDidChangeMetadata(() => {
			this.viewUpdate();
		}));

		this._register(this.viewCell.onDidChangeState((e) => {
			if (e.editStateChanged || e.contentChanged) {
				this.viewUpdate();
			}

			if (e.focusModeChanged) {
				this.updateForFocusModeChange();
			}

			if (e.foldingStateChanged) {
				const foldingState = this.viewCell.foldingState;

				if (foldingState !== this.foldingState) {
					this.foldingState = foldingState;
					this.setFoldingIndicator();
				}
			}

			if (e.cellIsHoveredChanged) {
				this.updateForHover();
			}

			if (e.inputCollapsedChanged) {
				this.updateCollapsedState();
				this.viewUpdate();
			}

			if (e.cellLineNumberChanged) {
				this.cellEditorOptions.setLineNumbers(this.viewCell.lineNumbers);
			}
		}));

		this._register(this.notebookEditor.notebookOptions.onDidChangeOptions(e => {
			if (e.showFoldingControls) {
				this.updateFoldingIconShowClass();
			}
		}));

		this._register(this.viewCell.onDidChangeLayout((e) => {
			const layoutInfo = this.editor?.getLayoutInfo();
			if (e.outerWidth && this.viewCell.getEditState() === CellEditState.Editing && layoutInfo && layoutInfo.width !== this.viewCell.layoutInfo.editorWidth) {
				this.onCellEditorWidthChange();
			} else if (e.totalHeight || e.outerWidth) {
				this.relayoutCell();
			}
		}));

		this._register(this.cellEditorOptions.onDidChange(() => {
			this.updateEditorOptions(this.cellEditorOptions.getUpdatedValue(this.viewCell.internalMetadata, this.viewCell.uri));
		}));
	}

	private updateCollapsedState() {
		if (this.viewCell.isInputCollapsed) {
			this.notebookEditor.hideMarkupPreviews([this.viewCell]);
		} else {
			this.notebookEditor.unhideMarkupPreviews([this.viewCell]);
		}
	}

	private updateForHover(): void {
		this.templateData.container.classList.toggle('markdown-cell-hover', this.viewCell.cellIsHovered);
	}

	private updateForFocusModeChange() {
		if (this.viewCell.focusMode === CellFocusMode.Editor) {
			this.focusEditorIfNeeded();
		}

		this.templateData.container.classList.toggle('cell-editor-focus', this.viewCell.focusMode === CellFocusMode.Editor);
	}

	private applyDecorations() {
		// apply decorations
		this._register(this.viewCell.onCellDecorationsChanged((e) => {
			e.added.forEach(options => {
				if (options.className) {
					this.notebookEditor.deltaCellOutputContainerClassNames(this.viewCell.id, [options.className], []);
				}
			});

			e.removed.forEach(options => {
				if (options.className) {
					this.notebookEditor.deltaCellOutputContainerClassNames(this.viewCell.id, [], [options.className]);
				}
			});
		}));

		this.viewCell.getCellDecorations().forEach(options => {
			if (options.className) {
				this.notebookEditor.deltaCellOutputContainerClassNames(this.viewCell.id, [options.className], []);
			}
		});
	}

	override dispose() {
		// move focus back to the cell list otherwise the focus goes to body
		if (this.notebookEditor.getActiveCell() === this.viewCell && this.viewCell.focusMode === CellFocusMode.Editor) {
			this.notebookEditor.focusContainer();
		}

		this.viewCell.detachTextEditor();
		super.dispose();
	}

	private updateFoldingIconShowClass() {
		const showFoldingIcon = this.notebookEditor.notebookOptions.getLayoutConfiguration().showFoldingControls;
		this.templateData.foldingIndicator.classList.remove('mouseover', 'always');
		this.templateData.foldingIndicator.classList.add(showFoldingIcon);
	}

	private viewUpdate(): void {
		if (this.viewCell.isInputCollapsed) {
			this.viewUpdateCollapsed();
		} else if (this.viewCell.getEditState() === CellEditState.Editing) {
			this.viewUpdateEditing();
		} else {
			this.viewUpdatePreview();
		}
	}

	private viewUpdateCollapsed(): void {
		DOM.show(this.templateData.cellInputCollapsedContainer);
		DOM.hide(this.editorPart);

		this.templateData.cellInputCollapsedContainer.innerText = '';
		const richEditorText = this.getRichText(this.viewCell.textBuffer, this.viewCell.language);
		const element = DOM.$('div');
		element.classList.add('cell-collapse-preview');
		DOM.safeInnerHtml(element, richEditorText);
		this.templateData.cellInputCollapsedContainer.appendChild(element);

		this.markdownAccessibilityContainer.ariaHidden = 'true';

		this.templateData.container.classList.toggle('input-collapsed', true);
		this.viewCell.renderedMarkdownHeight = 0;
		this.viewCell.layoutChange({});
	}

	private getRichText(buffer: IReadonlyTextBuffer, language: string) {
		return tokenizeToStringSync(this.languageService, buffer.getLineContent(1), language);
	}

	private viewUpdateEditing(): void {
		// switch to editing mode
		let editorHeight: number;

		DOM.show(this.editorPart);
		this.markdownAccessibilityContainer.ariaHidden = 'true';
		DOM.hide(this.templateData.cellInputCollapsedContainer);

		this.notebookEditor.hideMarkupPreviews([this.viewCell]);

		this.templateData.container.classList.toggle('input-collapsed', false);
		this.templateData.container.classList.toggle('markdown-cell-edit-mode', true);

		if (this.editor && this.editor.hasModel()) {
			editorHeight = this.editor.getContentHeight();

			// not first time, we don't need to create editor
			this.viewCell.attachTextEditor(this.editor);
			this.focusEditorIfNeeded();

			this.bindEditorListeners(this.editor);

			this.editor.layout({
				width: this.viewCell.layoutInfo.editorWidth,
				height: editorHeight
			});
		} else {
			this.editorDisposables.clear();
			const width = this.notebookEditor.notebookOptions.computeMarkdownCellEditorWidth(this.notebookEditor.getLayoutInfo().width);
			const lineNum = this.viewCell.lineCount;
			const lineHeight = this.viewCell.layoutInfo.fontInfo?.lineHeight || 17;
			const editorPadding = this.notebookEditor.notebookOptions.computeEditorPadding(this.viewCell.internalMetadata, this.viewCell.uri);
			editorHeight = Math.max(lineNum, 1) * lineHeight + editorPadding.top + editorPadding.bottom;

			this.templateData.editorContainer.innerText = '';

			// create a special context key service that set the inCompositeEditor-contextkey
			const editorContextKeyService = this.contextKeyService.createScoped(this.templateData.editorPart);
			EditorContextKeys.inCompositeEditor.bindTo(editorContextKeyService).set(true);
			const editorInstaService = this.instantiationService.createChild(new ServiceCollection([IContextKeyService, editorContextKeyService]));
			this.editorDisposables.add(editorContextKeyService);

			this.editor = this.editorDisposables.add(editorInstaService.createInstance(CodeEditorWidget, this.templateData.editorContainer, {
				...this.editorOptions,
				dimension: {
					width: width,
					height: editorHeight
				},
				// overflowWidgetsDomNode: this.notebookEditor.getOverflowContainerDomNode()
			}, {
				contributions: this.notebookEditor.creationOptions.cellEditorContributions
			}));
			this.templateData.currentEditor = this.editor;

			const cts = new CancellationTokenSource();
			this.editorDisposables.add({ dispose() { cts.dispose(true); } });
			raceCancellation(this.viewCell.resolveTextModel(), cts.token).then(model => {
				if (!model) {
					return;
				}

				this.editor!.setModel(model);

				const realContentHeight = this.editor!.getContentHeight();
				if (realContentHeight !== editorHeight) {
					this.editor!.layout(
						{
							width: width,
							height: realContentHeight
						}
					);
					editorHeight = realContentHeight;
				}

				this.viewCell.attachTextEditor(this.editor!);

				if (this.viewCell.getEditState() === CellEditState.Editing) {
					this.focusEditorIfNeeded();
				}

				this.bindEditorListeners(this.editor!);

				this.viewCell.editorHeight = editorHeight;
			});
		}

		this.viewCell.editorHeight = editorHeight;
		this.focusEditorIfNeeded();
		this.renderedEditors.set(this.viewCell, this.editor!);
	}

	private viewUpdatePreview(): void {
		this.viewCell.detachTextEditor();
		DOM.hide(this.editorPart);
		DOM.hide(this.templateData.cellInputCollapsedContainer);
		this.markdownAccessibilityContainer.ariaHidden = 'false';
		this.templateData.container.classList.toggle('collapsed', false);
		this.templateData.container.classList.toggle('markdown-cell-edit-mode', false);

		this.renderedEditors.delete(this.viewCell);

		this.markdownAccessibilityContainer.innerText = '';
		if (this.viewCell.renderedHtml) {
			DOM.safeInnerHtml(this.markdownAccessibilityContainer, this.viewCell.renderedHtml);
		}

		this.notebookEditor.createMarkupPreview(this.viewCell);
	}

	private focusEditorIfNeeded() {
		if (this.viewCell.focusMode === CellFocusMode.Editor &&
			(this.notebookEditor.hasEditorFocus() || document.activeElement === document.body)
		) { // Don't steal focus from other workbench parts, but if body has focus, we can take it
			if (!this.editor) {
				return;
			}

			this.editor.focus();

			const primarySelection = this.editor.getSelection();
			if (!primarySelection) {
				return;
			}

			this.notebookEditor.revealRangeInViewAsync(this.viewCell, primarySelection);
		}
	}

	private layoutEditor(dimension: DOM.IDimension): void {
		this.editor?.layout(dimension);
	}

	private onCellEditorWidthChange(): void {
		const realContentHeight = this.editor!.getContentHeight();
		this.layoutEditor(
			{
				width: this.viewCell.layoutInfo.editorWidth,
				height: realContentHeight
			}
		);

		// LET the content size observer to handle it
		// this.viewCell.editorHeight = realContentHeight;
		// this.relayoutCell();
	}

	relayoutCell(): void {
		this.notebookEditor.layoutNotebookCell(this.viewCell, this.viewCell.layoutInfo.totalHeight);
	}

	updateEditorOptions(newValue: IEditorOptions): void {
		this.editorOptions = newValue;
		if (this.editor) {
			this.editor.updateOptions(this.editorOptions);
		}
	}

	setFoldingIndicator() {
		switch (this.foldingState) {
			case CellFoldingState.None:
				this.templateData.foldingIndicator.innerText = '';
				break;
			case CellFoldingState.Collapsed:
				DOM.reset(this.templateData.foldingIndicator, renderIcon(collapsedIcon));
				break;
			case CellFoldingState.Expanded:
				DOM.reset(this.templateData.foldingIndicator, renderIcon(expandedIcon));
				break;

			default:
				break;
		}
	}

	private bindEditorListeners(editor: CodeEditorWidget) {

		this.localDisposables.clear();
		this.focusSwitchDisposable.clear();

		this.localDisposables.add(editor.onDidContentSizeChange(e => {
			const viewLayout = editor.getLayoutInfo();

			if (e.contentHeightChanged) {
				this.viewCell.editorHeight = e.contentHeight;
				editor.layout(
					{
						width: viewLayout.width,
						height: e.contentHeight
					}
				);
			}
		}));

		this.localDisposables.add(editor.onDidChangeCursorSelection((e) => {
			if (e.source === 'restoreState') {
				// do not reveal the cell into view if this selection change was caused by restoring editors...
				return;
			}

			const primarySelection = editor.getSelection();

			if (primarySelection) {
				this.notebookEditor.revealRangeInViewAsync(this.viewCell, primarySelection);
			}
		}));

		const updateFocusMode = () => this.viewCell.focusMode = editor.hasWidgetFocus() ? CellFocusMode.Editor : CellFocusMode.Container;
		this.localDisposables.add(editor.onDidFocusEditorWidget(() => {
			updateFocusMode();
		}));

		this.localDisposables.add(editor.onDidBlurEditorWidget(() => {
			// this is for a special case:
			// users click the status bar empty space, which we will then focus the editor
			// so we don't want to update the focus state too eagerly
			if (document.activeElement?.contains(this.templateData.container)) {
				this.focusSwitchDisposable.value = disposableTimeout(() => updateFocusMode(), 300);
			} else {
				updateFocusMode();
			}
		}));

		updateFocusMode();
	}
}
