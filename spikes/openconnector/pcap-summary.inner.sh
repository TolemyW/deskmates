#!/bin/sh
# Runs inside the tcpdump image; see pcap-summary.sh. The capture is `-i any`, so every line carries a
# direction (In/Out) and Docker's embedded DNS shows up on 127.0.0.11 at a NATed high port, not 53.
PCAP=/out/runtime-netns.pcap
rd() { tcpdump -n -tttt -r "$PCAP" "$@" 2>/dev/null; }

echo "packets: $(rd | wc -l)"
echo "first packet: $(rd | head -1 | cut -c1-26)"
echo "last packet:  $(rd | tail -1 | cut -c1-26)"
echo
echo "DNS questions to Docker's resolver (count, type, name); -T domain decodes the NATed port:"
rd -T domain 'udp and dst host 127.0.0.11' | grep -oE '(A|AAAA)\? [^ ]+' | sort | uniq -c
echo
echo "DNS answers (count, rcode/answer):"
rd 'udp and src host 127.0.0.11' | sed -E 's/^.*: [0-9]+ //' | sort | uniq -c
echo
echo "Every TCP SYN (connection attempts, both directions):"
rd 'tcp[tcpflags] & tcp-syn != 0 and tcp[tcpflags] & tcp-ack == 0'
echo
echo "UDP that is not to or from Docker's resolver:"
rd 'udp and not host 127.0.0.11'
echo
echo "Distinct IP addresses seen:"
rd ip | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | sort | uniq -c
