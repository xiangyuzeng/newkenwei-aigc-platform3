module.exports = {
  apps: [
    {
      name: 'kenwei-aigc',
      script: 'server.js',
      env: {
        PORT: 3000,
        UPSTREAM_GATEWAY_BASE: 'https://api.duu.men'
      }
    }
  ]
};
