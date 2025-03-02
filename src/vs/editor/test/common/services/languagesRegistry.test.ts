/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { URI } from 'vs/base/common/uri';
import { LanguagesRegistry } from 'vs/editor/common/services/languagesRegistry';

suite('LanguagesRegistry', () => {

	test('output language does not have a name', () => {
		let registry = new LanguagesRegistry(false);

		registry._registerLanguages([{
			id: 'outputLangId',
			extensions: [],
			aliases: [],
			mimetypes: ['outputLanguageMimeType'],
		}]);

		assert.deepStrictEqual(registry.getSortedRegisteredLanguageNames(), []);

		registry.dispose();
	});

	test('language with alias does have a name', () => {
		let registry = new LanguagesRegistry(false);

		registry._registerLanguages([{
			id: 'langId',
			extensions: [],
			aliases: ['LangName'],
			mimetypes: ['bla'],
		}]);

		assert.deepStrictEqual(registry.getSortedRegisteredLanguageNames(), [{ languageName: 'LangName', languageId: 'langId' }]);
		assert.deepStrictEqual(registry.getLanguageName('langId'), 'LangName');

		registry.dispose();
	});

	test('language without alias gets a name', () => {
		let registry = new LanguagesRegistry(false);

		registry._registerLanguages([{
			id: 'langId',
			extensions: [],
			mimetypes: ['bla'],
		}]);

		assert.deepStrictEqual(registry.getSortedRegisteredLanguageNames(), [{ languageName: 'langId', languageId: 'langId' }]);
		assert.deepStrictEqual(registry.getLanguageName('langId'), 'langId');

		registry.dispose();
	});

	test('bug #4360: f# not shown in status bar', () => {
		let registry = new LanguagesRegistry(false);

		registry._registerLanguages([{
			id: 'langId',
			extensions: ['.ext1'],
			aliases: ['LangName'],
			mimetypes: ['bla'],
		}]);

		registry._registerLanguages([{
			id: 'langId',
			extensions: ['.ext2'],
			aliases: [],
			mimetypes: ['bla'],
		}]);

		assert.deepStrictEqual(registry.getSortedRegisteredLanguageNames(), [{ languageName: 'LangName', languageId: 'langId' }]);
		assert.deepStrictEqual(registry.getLanguageName('langId'), 'LangName');

		registry.dispose();
	});

	test('issue #5278: Extension cannot override language name anymore', () => {
		let registry = new LanguagesRegistry(false);

		registry._registerLanguages([{
			id: 'langId',
			extensions: ['.ext1'],
			aliases: ['LangName'],
			mimetypes: ['bla'],
		}]);

		registry._registerLanguages([{
			id: 'langId',
			extensions: ['.ext2'],
			aliases: ['BetterLanguageName'],
			mimetypes: ['bla'],
		}]);

		assert.deepStrictEqual(registry.getSortedRegisteredLanguageNames(), [{ languageName: 'BetterLanguageName', languageId: 'langId' }]);
		assert.deepStrictEqual(registry.getLanguageName('langId'), 'BetterLanguageName');

		registry.dispose();
	});

	test('mimetypes are generated if necessary', () => {
		let registry = new LanguagesRegistry(false);

		registry._registerLanguages([{
			id: 'langId'
		}]);

		assert.deepStrictEqual(registry.getMimeType('langId'), 'text/x-langId');

		registry.dispose();
	});

	test('first mimetype wins', () => {
		let registry = new LanguagesRegistry(false);

		registry._registerLanguages([{
			id: 'langId',
			mimetypes: ['text/langId', 'text/langId2']
		}]);

		assert.deepStrictEqual(registry.getMimeType('langId'), 'text/langId');

		registry.dispose();
	});

	test('first mimetype wins 2', () => {
		let registry = new LanguagesRegistry(false);

		registry._registerLanguages([{
			id: 'langId'
		}]);

		registry._registerLanguages([{
			id: 'langId',
			mimetypes: ['text/langId']
		}]);

		assert.deepStrictEqual(registry.getMimeType('langId'), 'text/x-langId');

		registry.dispose();
	});

	test('aliases', () => {
		let registry = new LanguagesRegistry(false);

		registry._registerLanguages([{
			id: 'a'
		}]);

		assert.deepStrictEqual(registry.getSortedRegisteredLanguageNames(), [{ languageName: 'a', languageId: 'a' }]);
		assert.deepStrictEqual(registry.getLanguageIdByLanguageName('a'), 'a');
		assert.deepStrictEqual(registry.getLanguageName('a'), 'a');

		registry._registerLanguages([{
			id: 'a',
			aliases: ['A1', 'A2']
		}]);

		assert.deepStrictEqual(registry.getSortedRegisteredLanguageNames(), [{ languageName: 'A1', languageId: 'a' }]);
		assert.deepStrictEqual(registry.getLanguageIdByLanguageName('a'), 'a');
		assert.deepStrictEqual(registry.getLanguageIdByLanguageName('a1'), 'a');
		assert.deepStrictEqual(registry.getLanguageIdByLanguageName('a2'), 'a');
		assert.deepStrictEqual(registry.getLanguageName('a'), 'A1');

		registry._registerLanguages([{
			id: 'a',
			aliases: ['A3', 'A4']
		}]);

		assert.deepStrictEqual(registry.getSortedRegisteredLanguageNames(), [{ languageName: 'A3', languageId: 'a' }]);
		assert.deepStrictEqual(registry.getLanguageIdByLanguageName('a'), 'a');
		assert.deepStrictEqual(registry.getLanguageIdByLanguageName('a1'), 'a');
		assert.deepStrictEqual(registry.getLanguageIdByLanguageName('a2'), 'a');
		assert.deepStrictEqual(registry.getLanguageIdByLanguageName('a3'), 'a');
		assert.deepStrictEqual(registry.getLanguageIdByLanguageName('a4'), 'a');
		assert.deepStrictEqual(registry.getLanguageName('a'), 'A3');

		registry.dispose();
	});

	test('empty aliases array means no alias', () => {
		let registry = new LanguagesRegistry(false);

		registry._registerLanguages([{
			id: 'a'
		}]);

		assert.deepStrictEqual(registry.getSortedRegisteredLanguageNames(), [{ languageName: 'a', languageId: 'a' }]);
		assert.deepStrictEqual(registry.getLanguageIdByLanguageName('a'), 'a');
		assert.deepStrictEqual(registry.getLanguageName('a'), 'a');

		registry._registerLanguages([{
			id: 'b',
			aliases: []
		}]);

		assert.deepStrictEqual(registry.getSortedRegisteredLanguageNames(), [{ languageName: 'a', languageId: 'a' }]);
		assert.deepStrictEqual(registry.getLanguageIdByLanguageName('a'), 'a');
		assert.deepStrictEqual(registry.getLanguageIdByLanguageName('b'), 'b');
		assert.deepStrictEqual(registry.getLanguageName('a'), 'a');
		assert.deepStrictEqual(registry.getLanguageName('b'), null);

		registry.dispose();
	});

	test('extensions', () => {
		let registry = new LanguagesRegistry(false);

		registry._registerLanguages([{
			id: 'a',
			aliases: ['aName'],
			extensions: ['aExt']
		}]);

		assert.deepStrictEqual(registry.getExtensions('a'), ['aExt']);

		registry._registerLanguages([{
			id: 'a',
			extensions: ['aExt2']
		}]);

		assert.deepStrictEqual(registry.getExtensions('a'), ['aExt', 'aExt2']);

		registry.dispose();
	});

	test('extensions of primary language registration come first', () => {
		let registry = new LanguagesRegistry(false);

		registry._registerLanguages([{
			id: 'a',
			extensions: ['aExt3']
		}]);

		assert.deepStrictEqual(registry.getExtensions('a')[0], 'aExt3');

		registry._registerLanguages([{
			id: 'a',
			configuration: URI.file('conf.json'),
			extensions: ['aExt']
		}]);

		assert.deepStrictEqual(registry.getExtensions('a')[0], 'aExt');

		registry._registerLanguages([{
			id: 'a',
			extensions: ['aExt2']
		}]);

		assert.deepStrictEqual(registry.getExtensions('a')[0], 'aExt');

		registry.dispose();
	});

	test('filenames', () => {
		let registry = new LanguagesRegistry(false);

		registry._registerLanguages([{
			id: 'a',
			aliases: ['aName'],
			filenames: ['aFilename']
		}]);

		assert.deepStrictEqual(registry.getFilenames('a'), ['aFilename']);

		registry._registerLanguages([{
			id: 'a',
			filenames: ['aFilename2']
		}]);

		assert.deepStrictEqual(registry.getFilenames('a'), ['aFilename', 'aFilename2']);

		registry.dispose();
	});

	test('configuration', () => {
		let registry = new LanguagesRegistry(false);

		registry._registerLanguages([{
			id: 'a',
			aliases: ['aName'],
			configuration: URI.file('/path/to/aFilename')
		}]);

		assert.deepStrictEqual(registry.getConfigurationFiles('a'), [URI.file('/path/to/aFilename')]);
		assert.deepStrictEqual(registry.getConfigurationFiles('aname'), []);
		assert.deepStrictEqual(registry.getConfigurationFiles('aName'), []);

		registry._registerLanguages([{
			id: 'a',
			configuration: URI.file('/path/to/aFilename2')
		}]);

		assert.deepStrictEqual(registry.getConfigurationFiles('a'), [URI.file('/path/to/aFilename'), URI.file('/path/to/aFilename2')]);
		assert.deepStrictEqual(registry.getConfigurationFiles('aname'), []);
		assert.deepStrictEqual(registry.getConfigurationFiles('aName'), []);

		registry.dispose();
	});
});
