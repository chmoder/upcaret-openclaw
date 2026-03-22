/**
 * PM2 ecosystem file — manages dispatch-cron.js as a persistent process.
 *
 * Usage:
 *   pm2 start ecosystem.config.js     # start
 *   pm2 stop advisor-cron             # stop
 *   pm2 restart advisor-cron          # restart
 *   pm2 logs advisor-cron             # tail logs
 *   pm2 status                        # process list
 *
 * For boot persistence (non-Docker):
 *   pm2 startup                       # prints a command — run it once as root/sudo
 *   pm2 save                          # save current process list
 *
 * For Docker:
 *   docker exec <container> pm2 start ecosystem.config.js
 */

module.exports = {
  apps: [
    {
      name:          'advisor-cron',
      script:        'scripts/dispatch-cron.js',
      cwd:           __dirname,
      autorestart:   true,
      env: {
        NODE_NO_WARNINGS: '1',
      },
      restart_delay: 5000,   // 5s between crash restarts
      max_restarts:  20,
      watch:         false,
      log_date_format: 'HH:mm:ss',
      error_file:    'logs/advisor-cron-error.log',
      out_file:      'logs/advisor-cron-out.log',
      merge_logs:    true,
    },
  ],
};
