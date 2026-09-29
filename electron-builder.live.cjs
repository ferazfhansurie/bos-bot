// Live distribution is explicit and refuses unsigned Windows artifacts.
module.exports = {
  extends: './electron-builder.yml',
  extraMetadata: { bosChannel: 'live', name: 'bos-bot' },
  forceCodeSigning: true,
  win: {
    signtoolOptions: { publisherName: process.env.BOS_WINDOWS_PUBLISHER },
    verifyUpdateCodeSignature: true,
  },
};
