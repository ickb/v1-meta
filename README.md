# iCKB v1 meta utility

## Run the utility for adding iCKB xUDT metadata on testnet

1. Download this repo in a folder of your choice:  

```bash
git clone https://github.com/ickb/v1-meta.git
```

2. Enter into the repo folder:

```bash
cd v1-meta
```

3. Install dependencies:

```bash
pnpm install
```

4. Build project:

```bash
pnpm build
```

5. Define a `env/testnet/.env` file, for example:

```
CHAIN=testnet
META_PRIVATE_KEY=0x-YOUR-SECP256K1-BLAKE160-PRIVATE-KEY
META_SLEEP_INTERVAL=60
```

Optionally the property `RPC_URL` can also be specified:

```
RPC_URL=http://127.0.0.1:8114/
```

6. Start the utility:

```bash
export CHAIN=testnet;
pnpm run start;
```

## Licensing

The license for this repository is the MIT License, see the [`LICENSE`](./LICENSE).
