import { Command } from 'commander'

const program = new Command()

program
  .name('harness')
  .description('Harness v1 engine — event-log initiative memory for coding agents')
  .version('0.1.0')

program.parse()
