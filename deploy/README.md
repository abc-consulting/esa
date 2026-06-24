# Deploying to Oracle Cloud (Ubuntu 22.04)

One-command setup: nginx on port 80 → Node.js app on port 5510. No build step, no npm dependencies.

---

## Step 1 — Provision the instance (OCI console)

1. Open the [OCI console](https://cloud.oracle.com) → **Compute → Instances → Create Instance**
2. **Image:** Canonical Ubuntu 22.04 (click *Change image* if needed)
3. **Shape:** Choose an Always Free eligible shape:
   - `VM.Standard.E2.1.Micro` (x86, 1 OCPU, 1 GB RAM)
   - `VM.Standard.A1.Flex` (Ampere/ARM, 1 OCPU, 6 GB RAM) — better value
4. **Networking:** Keep the default VCN; tick **Assign a public IPv4 address**
5. **SSH keys:** Paste your public key (or generate one and download the private key)
6. Click **Create** and wait for **Running** status
7. Copy the **Public IP** from the instance detail page

---

## Step 2 — Open port 80 in the OCI Security List

The OCI-level firewall must be opened separately from the OS firewall.

1. **Networking → Virtual Cloud Networks → your VCN**
2. Click **Security Lists → Default Security List**
3. Click **Add Ingress Rules**
4. Set:
   - Source CIDR: `0.0.0.0/0`
   - IP Protocol: `TCP`
   - Destination Port Range: `80`
5. Save

> Port 22 (SSH) is usually pre-configured. If you can't SSH in, add an ingress rule for port 22 the same way.

---

## Step 3 — SSH in and run the setup script

```bash
ssh ubuntu@<PUBLIC_IP>
```

Then run the setup script (clones the repo and configures everything):

```bash
git clone https://github.com/abc-consulting/esa.git
cd esa
sudo bash deploy/setup.sh
```

The script will:
- Install Node.js LTS and nginx
- Clone the repo to `/opt/esa`
- Create a `systemd` service that starts on boot
- Configure nginx as a reverse proxy
- Open ports 22 and 80 via `ufw`
- Print the app URL when done

---

## Step 4 — Set RedVelvet credentials (optional)

Without credentials the app runs in anonymous mode (some RV profile details may be missing).

```bash
sudo nano /etc/esa/env
```

Uncomment and fill in:

```
RV_EMAIL=your@email.com
RV_PASSWORD=yourpassword
```

Then restart the service:

```bash
sudo systemctl restart esa
```

---

## Accessing the app

```
http://<PUBLIC_IP>
```

---

## Updating the app

SSH into the instance and run:

```bash
sudo -u esa git -C /opt/esa pull --ff-only
sudo systemctl restart esa
```

---

## Useful commands

| Command | Purpose |
|---------|---------|
| `systemctl status esa` | Check if the app is running |
| `journalctl -u esa -f` | Tail live app logs |
| `systemctl restart esa` | Restart the app |
| `nginx -t && systemctl reload nginx` | Validate and reload nginx config |
| `systemctl status nginx` | Check nginx status |
