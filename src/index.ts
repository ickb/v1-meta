import {
  TransactionSkeleton,
  encodeToAddress,
  sealTransaction,
  type TransactionSkeletonType,
} from "@ckb-lumos/helpers";
import { prepareSigningEntries } from "@ckb-lumos/common-scripts/lib/secp256k1_blake160.js";
import { key } from "@ckb-lumos/hd";
import {
  I8Cell,
  I8CellDep,
  I8Header,
  I8Script,
  ScriptConfigAdapter,
  Uint64,
  Uint8,
  addCells,
  addCkbChange,
  addWitnessPlaceholder,
  calculateTxFee,
  capacitySifter,
  cellDeps,
  chainConfigFrom,
  i8ScriptPadding,
  isChain,
  lockExpanderFrom,
  max,
  txSize,
  type Chain,
  type ChainConfig,
  type ConfigAdapter,
} from "@ickb/lumos-utils";
import {
  addIckbUdtChange,
  getIckbScriptConfigs,
  ickbSifter,
} from "@ickb/v1-core";
import type { Input } from "@ckb-lumos/base";
import { CKBHasher } from "@ckb-lumos/base/lib/utils.js";
import { CellInput } from "@ckb-lumos/base/lib/blockchain.js";
import { concat, hexify } from "@ckb-lumos/codec/lib/bytes.js";

async function main() {
  const { CHAIN, RPC_URL, META_PRIVATE_KEY, META_SLEEP_INTERVAL } = process.env;
  if (!isChain(CHAIN) || CHAIN === "devnet") {
    throw Error("Invalid env CHAIN: " + CHAIN);
  }
  if (!META_PRIVATE_KEY) {
    throw Error("Empty env META_PRIVATE_KEY");
  }
  if (!META_SLEEP_INTERVAL || Number(META_SLEEP_INTERVAL) < 1) {
    throw Error("Invalid env META_SLEEP_INTERVAL");
  }

  const chainConfig = await chainConfigFrom(
    CHAIN,
    RPC_URL,
    true,
    getIckbScriptConfigs,
    getUniqueScriptConfigs,
  );
  const { config, rpc } = chainConfig;
  const account = secp256k1Blake160(META_PRIVATE_KEY, config);
  const {
    lockScript: accountLock,
    preSigner: addPlaceholders,
    signer,
  } = account;

  const sleepInterval = Number(META_SLEEP_INTERVAL) * 1000;

  while (true) {
    await new Promise((r) => setTimeout(r, sleepInterval));
    console.log();
    try {
      const { capacities, receipts, feeRate } = await getL1State(
        account,
        chainConfig,
      );
      if (receipts.length === 0) {
        throw Error("No receipts found, impossible to mint iCKB xUDT");
      }

      // Populate inputs

      let tx = addCells(
        TransactionSkeleton(),
        "append",
        [receipts, capacities].flat(),
        [],
      );

      // Populate outputs

      // 1) Mint some iCKB xUDT
      let freeCkb, freeIckbUdt;
      ({ tx, freeIckbUdt } = addIckbUdtChange(tx, accountLock, config));
      if (freeIckbUdt <= 0n) {
        throw Error("Not enough iCKB xUDT");
      }

      // 2) Create the iCKB xUDT metadata cell
      tx = addUniqueCell(tx, 8, "iCKB", "iCKB", config);

      // 3) Add CKB change
      ({ tx, freeCkb } = addCkbChange(
        tx,
        accountLock,
        (txWithDummyChange: TransactionSkeletonType) =>
          calculateTxFee(txSize(addPlaceholders(txWithDummyChange)), feeRate),
        config,
      ));
      if (freeCkb < 0n) {
        throw Error("Not enough CKB");
      }

      const txHash = await rpc.sendTransaction(signer(tx));
      console.log("iCKB xUDT metadata added onchain with the transaction:");
      console.log(txHash);
      break;
    } catch (e: any) {
      console.log(e);
    }
  }
}

async function getL1State(
  account: ReturnType<typeof secp256k1Blake160>,
  chainConfig: ChainConfig,
) {
  const { config, rpc } = chainConfig;
  const { lockScript: accountLock, expander } = account;
  const mixedCells = await rpc.getCellsByLock(accountLock, "desc", "max");

  // Prefetch feeRate
  const feeRatePromise = rpc.getFeeRate(61n);

  // Prefetch headers
  const wanted = new Set<string>();
  const deferredGetHeader = (blockNumber: string) => {
    wanted.add(blockNumber);
    return headerPlaceholder;
  };
  const { notIckbs } = ickbSifter(
    mixedCells,
    expander,
    deferredGetHeader,
    config,
  );
  const headersPromise = getHeadersByNumber(wanted, chainConfig);

  const { capacities } = capacitySifter(notIckbs, expander);

  // Await for headers
  const headers = await headersPromise;

  // Sift iCKB's receipts cells
  const { receipts } = ickbSifter(
    mixedCells,
    expander,
    (blockNumber) => headers.get(blockNumber)!,
    config,
  );

  return {
    capacities,
    receipts,
    feeRate: max(await feeRatePromise, 1000n),
  };
}

async function getHeadersByNumber(
  wanted: Set<string>,
  chainConfig: ChainConfig,
) {
  const { rpc } = chainConfig;

  const result = new Map<string, Readonly<I8Header>>();
  const batch = rpc.createBatchRequest();
  for (const blockNum of wanted) {
    const h = _knownHeaders.get(blockNum);
    if (h !== undefined) {
      result.set(blockNum, h);
      continue;
    }
    batch.add("getHeaderByNumber", blockNum);
  }

  if (batch.length === 0) {
    return _knownHeaders;
  }

  for (const h of await batch.exec()) {
    result.set(h.number, I8Header.from(h));
  }

  const frozenResult = Object.freeze(result);
  _knownHeaders = frozenResult;
  return frozenResult;
}

let _knownHeaders = Object.freeze(new Map<string, Readonly<I8Header>>());

const headerPlaceholder = I8Header.from({
  compactTarget: "0x1a08a97e",
  parentHash:
    "0x0000000000000000000000000000000000000000000000000000000000000000",
  transactionsRoot:
    "0x31bf3fdf4bc16d6ea195dbae808e2b9a8eca6941d589f6959b1d070d51ac28f7",
  proposalsHash:
    "0x0000000000000000000000000000000000000000000000000000000000000000",
  extraHash:
    "0x0000000000000000000000000000000000000000000000000000000000000000",
  dao: "0x8874337e541ea12e0000c16ff286230029bfa3320800000000710b00c0fefe06",
  epoch: "0x0",
  hash: "0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5",
  nonce: "0x0",
  number: "0x0",
  timestamp: "0x16e70e6985c",
  version: "0x0",
});

function secp256k1Blake160(privateKey: string, config: ConfigAdapter) {
  const publicKey = key.privateToPublic(privateKey);

  const lockScript = I8Script.from({
    ...config.defaultScript("SECP256K1_BLAKE160"),
    args: key.publicKeyToBlake160(publicKey),
  });

  const address = encodeToAddress(lockScript, { config });

  const expander = lockExpanderFrom(lockScript);

  function preSigner(tx: TransactionSkeletonType) {
    return addWitnessPlaceholder(tx, lockScript);
  }

  function signer(tx: TransactionSkeletonType) {
    tx = preSigner(tx);
    tx = prepareSigningEntries(tx, { config });
    const message = tx.get("signingEntries").get(0)!.message; //How to improve in case of multiple locks?
    const sig = key.signRecoverable(message!, privateKey);

    return sealTransaction(tx, [sig]);
  }

  return {
    publicKey,
    lockScript,
    address,
    expander,
    preSigner,
    signer,
  };
}

function addUniqueCell(
  tx: TransactionSkeletonType,
  decimal: number,
  name: string,
  symbol: string,
  config: ConfigAdapter,
) {
  const metaUniqueCell = I8Cell.from({
    lock: I8Script.from({
      // SECP256K1_BLAKE160 lock with all zeros
      ...config.defaultScript("SECP256K1_BLAKE160"),
      args: "0x0000000000000000000000000000000000000000",
    }),
    type: I8Script.from({
      // UNIQUE_CELL with iCKB xUDT metadata
      ...config.defaultScript("UNIQUE_CELL"),
      args: uniqueArgs(
        {
          previousOutput: tx.inputs.get(0)!.outPoint!,
          since: "0x0",
        },
        tx.outputs.size, //Output index of this cell
      ),
    }),
    data: uniqueXudtMeta(decimal, name, symbol),
  });

  return addCells(tx, "append", [], [metaUniqueCell]);
}

function uniqueArgs(input: Input, uniqueCellOutputIndex: number) {
  const hasher = new CKBHasher();
  hasher.update(CellInput.pack(input));
  hasher.update(Uint64.pack(uniqueCellOutputIndex));
  return hasher.digestHex().slice(0, 42);
}

function uniqueXudtMeta(decimal: number, name: string, symbol: string) {
  return hexify(
    concat(
      Uint8.pack(decimal),
      Uint8.pack(name.length),
      new TextEncoder().encode(name),
      Uint8.pack(symbol.length),
      new TextEncoder().encode(symbol),
    ),
  );
}

function getUniqueScriptConfigs(
  chain: Chain,
  oldScriptConfigs: { [id: string]: ScriptConfigAdapter },
): typeof oldScriptConfigs {
  if (chain === "devnet") {
    throw Error("Devnet configuration not found");
  }

  if (chain === "testnet") {
    return {
      ...oldScriptConfigs,
      UNIQUE_CELL: new ScriptConfigAdapter(
        I8Script.from({
          ...i8ScriptPadding,
          codeHash:
            "0x8e341bcfec6393dcd41e635733ff2dca00a6af546949f70c57a706c0f344df8b",
          hashType: "type",
          [cellDeps]: [
            I8CellDep.from({
              outPoint: {
                txHash:
                  "0xff91b063c78ed06f10a1ed436122bd7d671f9a72ef5f5fa28d05252c17cf4cef",
                index: "0x0",
              },
              depType: "code",
            }),
          ],
        }),
      ),
    };
  }

  return {
    ...oldScriptConfigs,
    UNIQUE_CELL: new ScriptConfigAdapter(
      I8Script.from({
        ...i8ScriptPadding,
        codeHash:
          "0x2c8c11c985da60b0a330c61a85507416d6382c130ba67f0c47ab071e00aec628",
        hashType: "data1",
        [cellDeps]: [
          I8CellDep.from({
            outPoint: {
              txHash:
                "0x67524c01c0cb5492e499c7c7e406f2f9d823e162d6b0cf432eacde0c9808c2ad",
              index: "0x0",
            },
            depType: "code",
          }),
        ],
      }),
    ),
  };
}

main();
