const fs = require('node:fs');
const path = require('node:path');

// pi-ai 1.4.0 imports `@earendil-works/pi-telemetry` (ESM-only, `import`-only
// exports map, not hoisted by pnpm): resolve it next to pi-ai's real location.
const piTelemetryDir = path.join(
	path.dirname(fs.realpathSync(path.join(__dirname, 'node_modules/@earendil-works/pi-ai'))),
	'pi-telemetry',
);

module.exports = {
	preset: 'ts-jest',
	testEnvironment: 'jsdom',
	roots: ['<rootDir>/tests'],
	testMatch: ['**/__tests__/**/*.ts?(x)', '**/?(*.)+(spec|test).ts?(x)'],
	setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
	globals: {
		__BASE_PATH__: '/texlyre',
	},
	transformIgnorePatterns: [
		'node_modules/(?:(?!(?:@earendil-works|typebox|partial-json|wasm-latex-tools)).)*$',
	],
	moduleNameMapper: {
		'^@/(.*)$': '<rootDir>/src/$1',
		'^@src/(.*)$': '<rootDir>/src/$1',
		// Phase 8b: the shared write_section definition lives in the repo
		// root (no copy); `typebox` is the root copy it imports.
		'^@uktub-root/(.*)$': '<rootDir>/../$1',
		'^typebox$': '<rootDir>/../node_modules/typebox/build/index.mjs',
		'^@chelys/(.*)$': '<rootDir>/src/chelys/$1',
		'^@extras/(.*)$': '<rootDir>/extras/$1',
		'^@tests/(.*)$': '<rootDir>/tests/$1',
		'\\.(css|less|scss|sass)$': 'identity-obj-proxy',
		'\\.(jpg|jpeg|png|gif|svg)$': '<rootDir>/tests/mocks/fileMock.js',
		'^nanoid$': '<rootDir>/tests/mocks/nanoid.js',
		'^mime$': '<rootDir>/tests/mocks/mime.js',
		'^codemirror-helix$': '<rootDir>/tests/mocks/codemirror.js',
		'^codemirror-lang-bib$': '<rootDir>/tests/mocks/codemirror.js',
		'^codemirror-lang-latex$': '<rootDir>/tests/mocks/codemirror.js',
		'^codemirror-lang-typst$': '<rootDir>/tests/mocks/codemirror.js',
		'^@codemirror/lsp-client$':
			'<rootDir>/tests/mocks/codemirror-lsp-client.js',
		'^@replit/codemirror-vim$': '<rootDir>/tests/mocks/codemirror.js',
		'^pdfjs-dist$': '<rootDir>/tests/mocks/pdfjs.js',
		'^pdfjs-dist/build/pdf.worker.mjs\\?url$': '<rootDir>/tests/mocks/pdfjs.js',
		'^wasm-latex-tools$': '<rootDir>/tests/mocks/wasm-latex-tools.js',
		'^mathlive$': '<rootDir>/tests/mocks/mathlive.js',
		'^@milkdown/(.*)$': '<rootDir>/tests/mocks/milkdown.js',
		'^katex$': '<rootDir>/tests/mocks/katex.js',
		'^remark-math$': '<rootDir>/tests/mocks/remark-math.js',
		'^remark-frontmatter$': '<rootDir>/tests/mocks/remark-frontmatter.js',
		'^detypify-service$': '<rootDir>/tests/mocks/detypify-service.js',
		'^onnxruntime-web/wasm$': '<rootDir>/tests/mocks/detypify-service.js',
		'^texlyre-busytex$': '<rootDir>/tests/mocks/texlyre-busytex.js',
		// Phase 8a: the real ESM-only agent packages load via transform (the
		// pre-Phase-8a `tests/mocks/pi-ai.js` Type stub is retired; the vite
		// bundle always used the real package).
		'^@earendil-works/pi-agent-core$':
			'<rootDir>/node_modules/@earendil-works/pi-agent-core/dist/index.js',
		'^@earendil-works/pi-ai$': '<rootDir>/node_modules/@earendil-works/pi-ai/dist/index.js',
		'^@earendil-works/pi-ai/(.*)$': '<rootDir>/node_modules/@earendil-works/pi-ai/dist/$1.js',
		'^@earendil-works/pi-telemetry$': path.join(piTelemetryDir, 'dist/index.js'),
		'^@earendil-works/pi-telemetry/(.*)$': path.join(piTelemetryDir, 'dist/$1.js'),
	},
	collectCoverageFrom: [
		'src/**/*.{ts,tsx}',
		'!src/**/*.d.ts',
		'!src/vite-env.d.ts',
	],
	coverageProvider: 'v8',
	// NOTE (fabawi): Disabling threshold for now until we have proper coverage
	// coverageThreshold: {
	//     global: {
	//         branches: 60,
	//         functions: 60,
	//         lines: 60,
	//         statements: 60,
	//     },
	// },
	transform: {
		'^.+\\.tsx?$': [
			'ts-jest',
			{
				tsconfig: 'tsconfig.test.json',
				diagnostics: {
					ignoreCodes: [1343],
				},
				astTransformers: {
					before: [
						{
							path: 'ts-jest-mock-import-meta',
							options: {
								metaObjectReplacement: { url: 'https://texlyre.example.com', env: {} },
							},
						},
					],
				},
			},
		],
		// Phase 8a: also transform the real ESM-only agent packages (and the
		// ESM-only transitive deps they pull) from `node_modules` down to CJS.
		// Disjoint from the `.tsx?$` entry above. Diagnostics off: upstream
		// JS carries types jest never checks.
		'^.+\\.m?jsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json', diagnostics: false }],
	},
	moduleDirectories: ['node_modules', '<rootDir>'],
	testTimeout: 10000,
};
