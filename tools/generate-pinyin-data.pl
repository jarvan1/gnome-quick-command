#!/usr/bin/env perl

use strict;
use warnings;
use utf8;

binmode STDIN, ':encoding(UTF-8)';
binmode STDOUT, ':encoding(UTF-8)';

my %readings;
while (<>) {
    chomp;
    next unless /^(\p{Han})\t([a-z]+)\t([0-9.]+)/;

    my ($character, $pinyin, $weight) = ($1, $2, $3);
    my $current = $readings{$character}{$pinyin};
    $readings{$character}{$pinyin} = $weight
        if !defined($current) || $weight > $current;
}

print "// Generated from a Rime pinyin table. Do not edit by hand.\n";
print "export const PINYIN_DATA = `\n";
for my $character (sort keys %readings) {
    my @pinyin = sort {
        $readings{$character}{$b} <=> $readings{$character}{$a} || $a cmp $b
    } keys %{$readings{$character}};
    print "$character:", join(',', @pinyin), "\n";
}
print "`;\n";
