# umbrel-verus-datum

Docker image for the **Verus Datum** umbrelOS app: a solo mining stratum server for VerusCoin (VerusHash 2.2) plus a small web dashboard that manages it.

- The stratum server is [verus-datum-cli](https://github.com/dwarner5522/verus-datum-cli), pinned by commit in the `Dockerfile`. It gets block templates from a Verus daemon and hands the work to your miners. The image build runs its self-test against real Verus mainnet blocks.
- `server/server.js` stores the payout address, runs the stratum server once there is one, and serves the dashboard, its API and the Umbrel widget. It has no npm dependencies.
- `server/public/` is the dashboard UI.
- `icon.svg` is the Umbrel app icon.

The Umbrel package that uses this image is `dwarner-verus-datum` in [umbrel-app-store](https://github.com/dwarner5522/umbrel-app-store), where it uses the Verus Node app as its daemon.

## Where block rewards go

The payout address is entered in the dashboard and kept in `/data/settings.json`. The stratum server does not start until there is one. It asks the daemon to pay that address with every request for work and never hands out a block template that pays anywhere else; see the verus-datum-cli README for the details and the one caveat (use one daemon per payout address).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DAEMON_HOST` | required | host of the Verus daemon's RPC interface |
| `DAEMON_RPC_USER` | required | RPC username |
| `DAEMON_RPC_PASS` | required | RPC password |
| `DAEMON_RPC_PORT` | `27486` | RPC port |
| `STRATUM_PORT` | `9999` | port the miners connect to |
| `START_DIFFICULTY` | `8192` | share difficulty a miner starts with; it is then adjusted per miner |
| `DEVICE_DOMAIN_NAME` | none | hostname shown in the connect details |
| `PORT` | `3000` | dashboard port |

All state lives in `/data`: `settings.json` (payout address), `stratum.json` (the generated stratum server config, which contains the RPC password) and `blocks.log` (blocks found).

## Run it locally

```sh
docker build -t umbrel-verus-datum .
docker run --rm --init -p 3000:3000 -p 9999:9999 \
  -e DAEMON_HOST=192.168.1.10 -e DAEMON_RPC_USER=rpcuser -e DAEMON_RPC_PASS=change-me \
  -v verus-datum-data:/data umbrel-verus-datum
```

Then open http://localhost:3000.

## Publish

Pushing a `v*` tag runs `.github/workflows/build.yml`, which builds `linux/amd64` and `linux/arm64` and pushes `ghcr.io/<owner>/umbrel-verus-datum:<tag>`. The workflow summary prints the full `image:tag@sha256:digest` reference to paste into `dwarner-verus-datum/docker-compose.yml` in the app store. Make the package public in GitHub's package settings so Umbrel can pull it.

## Updating the stratum server

Change `STRATUM_COMMIT` in the `Dockerfile` to the new verus-datum-cli commit, then tag a new release.

## Credits and license

verus-datum-cli is based on s-nomp and VerusCoin's node-stratum-pool and is distributed under the GPL version 2. The Verus logo is from [VerusCoin/Media-Assets](https://github.com/VerusCoin/Media-Assets) (MIT, © 2020 Max Theyse).
