module.exports = {
  apps: [{
    name: "counterpart-monitor",
    script: "src/index.ts",
    interpreter: "bun",
    max_restarts: 10,
    restart_delay: 5000,
    env: {
      NODE_ENV: "production"
    }
  }]
};
