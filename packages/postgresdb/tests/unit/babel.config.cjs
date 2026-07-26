const { babelConfig } = require('@ttoss/config');

const config = babelConfig({});

/**
 * The models declare their columns as `declare publicId: string` so that the
 * `@Column` decorator owns the attribute and TypeScript emits no class field
 * that would shadow it. Babel rejects `declare` fields unless
 * `allowDeclareFields` is on, so swap the shared `@babel/preset-typescript`
 * entry for a configured one.
 */
config.presets = config.presets.map((preset) => {
  if (preset === '@babel/preset-typescript') {
    return ['@babel/preset-typescript', { allowDeclareFields: true }];
  }

  return preset;
});

module.exports = config;
