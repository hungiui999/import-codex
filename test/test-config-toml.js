'use strict';

const fs = require('fs');
const path = require('path');
const { test, assert, withFakeHome } = require('./_helpers');
const { ensureConfigToml, codexConfigPath } = require('../importer-core');

test('ensureConfigToml: creates config.toml when missing', () => {
  withFakeHome(() => {
    const file = ensureConfigToml({ baseUrl: 'http://127.0.0.1:20128' });
    assert.strictEqual(file, codexConfigPath());
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /model_provider = "9router"/);
    assert.match(text, /\[model_providers\.9router\]/);
    assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:20128\/v1"/);
    assert.match(text, /wire_api = "responses"/);
    // model line should default to cx/* prefix.
    assert.match(text, /^model = "cx\//m);
  });
});

test('ensureConfigToml: idempotent — running twice produces identical text', () => {
  withFakeHome(() => {
    ensureConfigToml({ baseUrl: 'http://127.0.0.1:20128' });
    const first = fs.readFileSync(codexConfigPath(), 'utf8');
    ensureConfigToml({ baseUrl: 'http://127.0.0.1:20128' });
    const second = fs.readFileSync(codexConfigPath(), 'utf8');
    assert.strictEqual(first, second);
  });
});

test('ensureConfigToml: prefixes bare model name with cx/', () => {
  withFakeHome(() => {
    const file = codexConfigPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'model = "gpt-5.5"\n', 'utf8');
    ensureConfigToml({ baseUrl: 'http://127.0.0.1:20128' });
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^model = "cx\/gpt-5\.5"$/m);
  });
});

test('ensureConfigToml: leaves prefixed model name alone', () => {
  withFakeHome(() => {
    const file = codexConfigPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'model = "openai/gpt-4o"\n', 'utf8');
    ensureConfigToml({ baseUrl: 'http://127.0.0.1:20128' });
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /^model = "openai\/gpt-4o"$/m);
  });
});

test('ensureConfigToml: replaces existing [model_providers.9router] block (no \\Z bug)', () => {
  withFakeHome(() => {
    const file = codexConfigPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Existing block at end of file with NO trailing section header. The old
    // regex used `\Z` (literal Z in JS) and failed to match this case.
    fs.writeFileSync(
      file,
      [
        'model_provider = "9router"',
        'model = "cx/gpt-5.5"',
        '',
        '[model_providers.9router]',
        'name = "Stale"',
        'base_url = "http://old:9999/v1"',
        'wire_api = "responses"',
        '',
      ].join('\n'),
      'utf8'
    );
    ensureConfigToml({ baseUrl: 'http://127.0.0.1:20128' });
    const text = fs.readFileSync(file, 'utf8');
    // Old base_url should be gone, new one in.
    assert.ok(!/old:9999/.test(text), 'stale base_url should be replaced');
    assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:20128\/v1"/);
    // No duplicate header.
    const headerCount = (text.match(/^\[model_providers\.9router\]/gm) || []).length;
    assert.strictEqual(headerCount, 1, 'header should appear exactly once');
  });
});

test('ensureConfigToml: preserves unrelated sections + keys', () => {
  withFakeHome(() => {
    const file = codexConfigPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        '# user preference',
        'model = "cx/gpt-4o"',
        '',
        '[model_providers.openai]',
        'name = "OpenAI"',
        'base_url = "https://api.openai.com/v1"',
        '',
        '[model_providers.9router]',
        'name = "Old"',
        'base_url = "http://old/v1"',
        'wire_api = "responses"',
        '',
        '[shell_environment_policy]',
        'inherit = "all"',
        '',
      ].join('\n'),
      'utf8'
    );
    ensureConfigToml({ baseUrl: 'http://127.0.0.1:20128' });
    const text = fs.readFileSync(file, 'utf8');
    // Unrelated sections preserved.
    assert.match(text, /\[model_providers\.openai\]/);
    assert.match(text, /name = "OpenAI"/);
    assert.match(text, /\[shell_environment_policy\]/);
    assert.match(text, /inherit = "all"/);
    // 9router block was rewritten.
    assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:20128\/v1"/);
    assert.ok(!/http:\/\/old\/v1/.test(text));
  });
});

test('ensureConfigToml: accepts baseUrl that already has /v1 suffix', () => {
  withFakeHome(() => {
    ensureConfigToml({ baseUrl: 'http://127.0.0.1:20128/v1' });
    const text = fs.readFileSync(codexConfigPath(), 'utf8');
    assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:20128\/v1"/);
    // Should not double-suffix.
    assert.ok(!/v1\/v1/.test(text));
  });
});
