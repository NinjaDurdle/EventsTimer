#!/usr/bin/env python3
"""
network-manager.py — Countdown Timer Network Manager

Runs as a systemd service BEFORE the Node.js timer process starts.
Decides whether to act as a DHCP server or client based on what it finds
on the network, and keeps monitoring so it can hand off if a real DHCP
server joins later.

Behaviour:
  1. Send a DHCP Discover on the primary interface and listen for 5 seconds.
  2. If a DHCP Offer arrives from a non-Pi device → stay in client mode (normal DHCP).
  3. If no offer, or only offers from other Pis → become the DHCP server:
       - Assign self a static IP: 192.168.39.1/24
       - Start dnsmasq to serve 192.168.39.10 – 192.168.39.200
  4. While running as server, poll every 30 seconds. If a real DHCP server
     appears (offer from a gateway, i.e. not a 192.168.39.x address):
       - Stop dnsmasq
       - Release static IP and request a DHCP lease instead

How to distinguish a "real" DHCP server from another Pi running this script:
  - Offers from 192.168.39.x are from another Pi acting as server → we
    stay as clients (one server is enough; first one wins).
  - Offers from outside 192.168.39.0/24 are from real routers → we defer.

Requirements (installed by install.sh):
  pip3 install scapy
  apt install dnsmasq
"""

import os
import sys
import time
import socket
import subprocess
import logging
import signal

# ── Config ────────────────────────────────────────────────────────────────────

IFACE          = os.environ.get("TIMER_IFACE", "eth0")  # override with env var
FALLBACK_IP    = "192.168.39.1"
FALLBACK_MASK  = "255.255.255.0"
FALLBACK_CIDR  = "192.168.39.1/24"
DHCP_RANGE_START = "192.168.39.10"
DHCP_RANGE_END   = "192.168.39.200"
DHCP_LEASE_TIME  = "12h"
DISCOVER_TIMEOUT    = 10     # seconds to wait for a DHCP offer per attempt
DISCOVER_ATTEMPTS   = 3      # how many times to try before giving up and self-hosting
CARRIER_WAIT_SECS   = 30     # max seconds to wait for ethernet carrier on boot
POLL_INTERVAL       = 30     # seconds between re-checks when acting as server
DNSMASQ_CONF     = "/etc/dnsmasq.d/countdown-timer.conf"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [network-manager] %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
log = logging.getLogger("network-manager")

# ── DHCP Discovery (raw socket) ───────────────────────────────────────────────
# We send a minimal DHCP Discover and listen for Offers without needing scapy,
# using raw sockets. This keeps the dependency footprint small.

import struct
import random

def build_dhcp_discover(xid, mac_bytes):
    """Build a minimal DHCPDISCOVER packet (RFC 2131)."""
    # BOOTP header
    packet = struct.pack(
        "!BBBBIHHIIII",
        1,          # op: BOOTREQUEST
        1,          # htype: Ethernet
        6,          # hlen: MAC length
        0,          # hops
        xid,        # transaction ID
        0,          # secs
        0x8000,     # flags: broadcast
        0, 0, 0, 0  # ciaddr, yiaddr, siaddr, giaddr
    )
    packet += mac_bytes + b"\x00" * 10   # chaddr (16 bytes)
    packet += b"\x00" * 64              # sname
    packet += b"\x00" * 128             # file
    # Magic cookie
    packet += b"\x63\x82\x53\x63"
    # Option 53: DHCP Discover
    packet += b"\x35\x01\x01"
    # Option 255: End
    packet += b"\xff"
    return packet

def get_mac_bytes(iface):
    """Return MAC address as 6 bytes for the given interface."""
    try:
        with open(f"/sys/class/net/{iface}/address") as f:
            mac = f.read().strip()
        return bytes(int(x, 16) for x in mac.split(":"))
    except Exception:
        return b"\x00" * 6

def discover_dhcp_server(iface, timeout=DISCOVER_TIMEOUT):
    """
    Broadcast a DHCP Discover on `iface` and return the server IP if an
    Offer is received within `timeout` seconds, else return None.
    """
    xid = random.randint(0, 0xFFFFFFFF)
    mac = get_mac_bytes(iface)
    packet = build_dhcp_discover(xid, mac)

    # Send socket (UDP broadcast on port 67)
    try:
        send_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        send_sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        send_sock.setsockopt(socket.SOL_SOCKET, socket.SO_BINDTODEVICE, iface.encode())
        send_sock.bind(("0.0.0.0", 68))
        send_sock.settimeout(timeout)
        send_sock.sendto(packet, ("255.255.255.255", 67))
    except OSError as e:
        log.warning(f"Could not send DHCP Discover ({e}) — assuming no DHCP server")
        return None

    # Listen for Offer
    deadline = time.time() + timeout
    while time.time() < deadline:
        remaining = deadline - time.time()
        if remaining <= 0:
            break
        try:
            send_sock.settimeout(remaining)
            data, addr = send_sock.recvfrom(1024)
            # A DHCP Offer is at least 240 bytes, magic cookie at offset 236,
            # option 53 value 2 somewhere after
            if len(data) >= 240 and data[236:240] == b"\x63\x82\x53\x63":
                # Check option 53 = 0x02 (Offer) somewhere in options
                options = data[240:]
                if b"\x35\x01\x02" in options:
                    server_ip = addr[0]
                    log.info(f"DHCP Offer received from {server_ip}")
                    send_sock.close()
                    return server_ip
        except socket.timeout:
            break
        except Exception as e:
            log.debug(f"Receive error: {e}")
            break

    send_sock.close()
    return None

def is_pi_server(ip):
    """Return True if `ip` is in the 192.168.39.x range (another Pi acting as server)."""
    return ip.startswith("192.168.39.")

# ── Network State Management ──────────────────────────────────────────────────

def run(cmd, check=False):
    """Run a shell command, logging it. Returns CompletedProcess."""
    log.debug(f"$ {cmd}")
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, check=check)

def interface_exists(iface):
    return os.path.exists(f"/sys/class/net/{iface}")

def is_wireless(iface):
    """Return True if the interface is a WiFi adapter.
    WiFi interfaces have a /sys/class/net/<iface>/wireless directory.
    """
    return os.path.exists(f"/sys/class/net/{iface}/wireless")

def wait_for_carrier(iface, timeout=CARRIER_WAIT_SECS):
    """Wait until the interface is ready to carry traffic.

    For ethernet: waits for /sys/class/net/<iface>/carrier == 1, which means
    the physical link is up and the switch has negotiated the connection.

    For WiFi: carrier goes to 1 as soon as the interface is up, before it has
    associated with an access point. We wait for an IP address to be assigned
    instead, which confirms the association and DHCP handshake have completed.
    This does mean on WiFi we're waiting for DHCP from the OS network manager
    (wpa_supplicant + dhclient / NetworkManager / dhcpcd) — if that succeeds
    we know the network is up and we skip our own DHCP discovery entirely.

    Returns True if ready within timeout, False if timed out.
    """
    deadline = time.time() + timeout

    if is_wireless(iface):
        log.info(f"{iface} is a wireless interface — waiting for IP address (association + DHCP)…")
        while time.time() < deadline:
            # Check if the interface has a non-loopback IPv4 address
            result = subprocess.run(
                f"ip -4 addr show {iface}",
                shell=True, capture_output=True, text=True
            )
            if "inet " in result.stdout:
                log.info(f"WiFi interface {iface} has an IP address — network is ready")
                return True
            time.sleep(1)
        log.warning(f"WiFi interface {iface} did not get an IP address within {timeout}s")
        return False
    else:
        # Ethernet — wait for physical carrier
        carrier_file = f"/sys/class/net/{iface}/carrier"
        while time.time() < deadline:
            try:
                with open(carrier_file) as f:
                    if f.read().strip() == "1":
                        log.info(f"Carrier detected on {iface}")
                        return True
            except OSError:
                pass  # file may not exist yet if interface not fully initialised
            time.sleep(0.5)
        log.warning(f"No carrier on {iface} after {timeout}s")
        return False

def set_static_ip(iface, cidr):
    """Flush existing addresses and set a static IP on the interface."""
    run(f"ip addr flush dev {iface}")
    run(f"ip addr add {cidr} dev {iface}")
    run(f"ip link set {iface} up")
    log.info(f"Static IP set: {cidr} on {iface}")

def release_static_ip(iface):
    run(f"ip addr flush dev {iface}")
    log.info(f"Released static IP on {iface}")

def start_dnsmasq(iface):
    """Write a dnsmasq config and start/restart the service."""
    conf = f"""# countdown-timer DHCP server — auto-generated, do not edit
interface={iface}
bind-interfaces
dhcp-range={DHCP_RANGE_START},{DHCP_RANGE_END},{DHCP_LEASE_TIME}
dhcp-option=3,{FALLBACK_IP}   # default gateway = this Pi
dhcp-option=6,{FALLBACK_IP}   # DNS = this Pi (dnsmasq handles basic DNS)
no-resolv
no-poll
"""
    try:
        with open(DNSMASQ_CONF, "w") as f:
            f.write(conf)
    except PermissionError:
        log.error(f"Cannot write {DNSMASQ_CONF} — are we running as root?")
        return

    run("systemctl restart dnsmasq")
    log.info(f"dnsmasq started — serving {DHCP_RANGE_START}–{DHCP_RANGE_END}")

def stop_dnsmasq():
    run("systemctl stop dnsmasq")
    try:
        if os.path.exists(DNSMASQ_CONF):
            os.unlink(DNSMASQ_CONF)
    except Exception:
        pass
    log.info("dnsmasq stopped")

def request_dhcp_lease(iface):
    """Request a fresh DHCP lease via dhclient.
    Releases any existing lease first so the DHCP server sees a clean request.
    """
    run(f"dhclient -r {iface}")   # release existing lease if any
    run(f"dhclient {iface}")      # request new lease
    log.info(f"DHCP lease requested on {iface}")

# ── Main Logic ────────────────────────────────────────────────────────────────

class NetworkManager:
    def __init__(self):
        self.mode   = None   # "client" or "server"
        self.iface  = IFACE
        self._running = True
        signal.signal(signal.SIGTERM, self._handle_signal)
        signal.signal(signal.SIGINT,  self._handle_signal)

    def _handle_signal(self, signum, frame):
        log.info("Shutting down…")
        self._running = False
        if self.mode == "server":
            stop_dnsmasq()

    def become_server(self):
        if self.mode == "server":
            return
        log.info("Becoming DHCP server on 192.168.39.0/24")
        # Release any existing DHCP lease before assigning the static IP
        run(f"dhclient -r {self.iface}")
        self.mode = "server"
        set_static_ip(self.iface, FALLBACK_CIDR)   # set_static_ip calls ip addr flush first
        start_dnsmasq(self.iface)

    def become_client(self, server_ip=None):
        if self.mode == "client":
            return
        if self.mode == "server":
            log.info(f"Real DHCP server detected ({server_ip}) — ceding DHCP control")
            stop_dnsmasq()

        # Always flush ALL addresses on the interface before requesting a lease.
        # This removes any leftover static IP (192.168.39.1) that may have been
        # set on a previous boot or by the network manager in server mode.
        # Without this, the interface ends up with both the static and DHCP IPs
        # simultaneously, confusing mDNS and routing.
        log.info(f"Flushing interface {self.iface} before requesting DHCP lease")
        release_static_ip(self.iface)  # release_static_ip calls ip addr flush

        self.mode = "client"
        request_dhcp_lease(self.iface)

    def run(self):
        if not interface_exists(self.iface):
            log.error(f"Interface {self.iface} not found. Set TIMER_IFACE env var.")
            sys.exit(1)

        log.info(f"Starting network detection on {self.iface}")

        # ── Step 1: Wait for physical carrier ─────────────────────────────────
        # Do not send any DHCP Discover until the ethernet link is actually up.
        # On boot, systemd starts this service quickly but the NIC takes time
        # to negotiate with the switch/router. Without this wait we send a
        # Discover into the void before the cable is even active and incorrectly
        # conclude there is no DHCP server.
        has_carrier = wait_for_carrier(self.iface, timeout=CARRIER_WAIT_SECS)
        if not has_carrier:
            if is_wireless(self.iface):
                # WiFi with no IP means either not configured, wrong password,
                # or no AP in range. We can't become a DHCP server on WiFi
                # (requires AP mode / hostapd). Just wait in client mode.
                log.warning(f"WiFi interface {self.iface} has no IP — check WiFi config. Running in client-only mode.")
                self.mode = "client"
            else:
                log.warning("No carrier — assuming no network, becoming DHCP server")
                self.become_server()
            # Fall through to monitoring loop; will cede if carrier + DHCP appears
        else:
            # Extra settling time after carrier — some switches take a moment
            # after link-up before passing traffic (STP port state transitions)
            log.info("Waiting 3s for switch to pass traffic after carrier…")
            time.sleep(3)

            # ── Step 2: Probe for existing DHCP server (with retries) ──────────
            # We try DISCOVER_ATTEMPTS times before concluding there's no server.
            # Each attempt sends a fresh Discover and waits DISCOVER_TIMEOUT secs.
            # This handles routers that are slow to respond after a power cycle.
            server_ip = None
            for attempt in range(1, DISCOVER_ATTEMPTS + 1):
                log.info(f"DHCP Discover attempt {attempt}/{DISCOVER_ATTEMPTS}…")
                server_ip = discover_dhcp_server(self.iface, timeout=DISCOVER_TIMEOUT)
                if server_ip is not None:
                    log.info(f"Got DHCP Offer from {server_ip} on attempt {attempt}")
                    break
                if attempt < DISCOVER_ATTEMPTS:
                    log.info(f"No response, retrying in 2s…")
                    time.sleep(2)

            if server_ip is None:
                log.info(f"No DHCP server found after {DISCOVER_ATTEMPTS} attempts — becoming server")
                self.become_server()
            elif is_pi_server(server_ip):
                log.info(f"Another Pi is DHCP server ({server_ip}) — joining as client")
                self.become_client(server_ip)
            else:
                log.info(f"Real DHCP server at {server_ip} — joining as client")
                self.become_client(server_ip)

        # ── Ongoing monitoring loop ────────────────────────────────────────────
        while self._running:
            time.sleep(POLL_INTERVAL)
            if not self._running:
                break

            if self.mode == "server" and not is_wireless(self.iface):
                # Check whether a real (non-Pi) DHCP server has appeared.
                # Filter out our own Offers (192.168.39.x).
                # WiFi interfaces never enter server mode so skip this check.
                found = discover_dhcp_server(self.iface, timeout=5)
                if found and not is_pi_server(found):
                    log.info(f"Real DHCP server appeared ({found}) — ceding control")
                    self.become_client(found)
            # In client mode, DHCP client handles renewals automatically


if __name__ == "__main__":
    if os.geteuid() != 0:
        print("network-manager.py must run as root", file=sys.stderr)
        sys.exit(1)
    NetworkManager().run()
