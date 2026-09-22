#!/usr/bin/perl
# A stand-in for util-linux flock(1) on hosts that lack it (macOS), speaking
# only what core/run-lock.ts asks of it: -x|-s, -n, -w <secs>, -E <code>,
# then <file> and either -c <command> or a command. Built on perl's flock,
# which is flock(2) — the primitive the real binary uses.
use strict;
use warnings;
use Fcntl qw(:flock O_RDONLY O_CREAT);
use Time::HiRes qw(sleep time);

my ($mode, $nonblock, $wait, $conflict) = (LOCK_EX, 0, undef, 1);
while (@ARGV && $ARGV[0] =~ /^-/) {
  my $opt = shift @ARGV;
  if ($opt eq '-x') { $mode = LOCK_EX }
  elsif ($opt eq '-s') { $mode = LOCK_SH }
  elsif ($opt eq '-n') { $nonblock = 1 }
  elsif ($opt eq '-w') { $wait = shift @ARGV }
  elsif ($opt eq '-E') { $conflict = shift @ARGV }
  else { exit 64 }
}
my $file = shift @ARGV;
sysopen(my $fh, $file, O_RDONLY | O_CREAT, 0644) or exit 66;
my $deadline = defined $wait ? time + $wait : undef;
until (flock($fh, $mode | LOCK_NB)) {
  exit $conflict if $nonblock || (defined $deadline && time >= $deadline);
  sleep 0.01;
}
my @cmd = ($ARGV[0] // '') eq '-c' ? ('/bin/sh', '-c', $ARGV[1]) : @ARGV;
my $pid = fork();
if (!$pid) { exec @cmd or exit 127 }
waitpid($pid, 0);
exit($? >> 8);
