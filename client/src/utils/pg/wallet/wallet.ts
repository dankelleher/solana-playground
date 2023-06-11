import { Keypair } from "@solana/web3.js";

import { createPgWalletInstance } from "./pg-wallet";
import { PgCommon } from "../common";
import {
  createDerivable,
  declareDerivable,
  declareUpdatable,
  derivable,
  migratable,
  updatable,
} from "../decorators";
import type {
  CurrentWallet,
  SerializedWallet,
  StandardWallet,
  StandardWalletProps,
  Wallet,
  WalletAccountName,
} from "./types";

const defaultState: Wallet = {
  state: "setup",
  accounts: [],
  currentIndex: -1,
  balance: null,
  show: false,
  standardWallets: [],
  standardName: null,
};

const storage = {
  /** Relative path to program info */
  KEY: `wallet`,

  /** Read from storage and deserialize the data. */
  async read(): Promise<Wallet> {
    const serializedStateStr = localStorage.getItem(this.KEY);
    if (!serializedStateStr) return defaultState;

    const serializedState: SerializedWallet = JSON.parse(serializedStateStr);
    return {
      ...serializedState,
      balance: defaultState.balance,
      show: defaultState.show,
      standardWallets: defaultState.standardWallets,
    };
  },

  /** Serialize the data and write to storage. */
  async write(wallet: Wallet) {
    // Don't use spread operator(...) because of the extra derived state
    const serializedState: SerializedWallet = {
      accounts: wallet.accounts,
      currentIndex: wallet.currentIndex,
      state: wallet.state,
      standardName: wallet.standardName,
    };

    localStorage.setItem(this.KEY, JSON.stringify(serializedState));
  },
};

const derive = () => ({
  // TODO: Doc
  standard: createDerivable({
    derive: (): StandardWallet => {
      const otherWallet = PgWallet.standardWallets.find(
        (wallet) => wallet.adapter.name === PgWallet.standardName
      );
      return otherWallet?.adapter ?? null;
    },
    onChange: ["standardWallets", "standardName"],
  }),

  /**
   * The current active wallet.
   *
   * It will be one of the following:
   * - The Playground Wallet
   * - A Wallet Standard wallet
   * - `null` if not connected.
   */
  current: createDerivable({
    derive: async (): Promise<CurrentWallet> => {
      switch (PgWallet.state) {
        case "pg": {
          // Check whether the current account exists
          const currentAccount = PgWallet.accounts[PgWallet.currentIndex];
          if (!currentAccount) {
            if (!PgWallet.accounts.length) PgWallet.add(null);
            else PgWallet.switch(0);

            return null;
          }

          return createPgWalletInstance(currentAccount);
        }

        case "sol":
          if (!PgWallet.standard || PgWallet.standard.connecting) return null;
          if (!PgWallet.standard.connected) await PgWallet.standard.connect();
          return PgWallet.standard as StandardWalletProps;

        case "disconnected":
        case "setup":
          return null;
      }
    },
    onChange: ["state", "currentIndex", "standard"],
  }),
});

// TODO: Remove in 2024
const migrate = () => {
  const walletStr = localStorage.getItem(storage.KEY);
  if (!walletStr) return;

  interface OldWallet {
    setupCompleted: boolean;
    connected: boolean;
    sk: Array<number>;
  }

  const oldOrNewWallet: OldWallet | Wallet = JSON.parse(walletStr);
  if ((oldOrNewWallet as Wallet).accounts) return;

  const oldWallet = oldOrNewWallet as OldWallet;
  const newWallet: Wallet = {
    ...defaultState,
    state: oldWallet.setupCompleted
      ? oldWallet.connected
        ? "pg"
        : "disconnected"
      : "setup",
    accounts: [{ kp: oldWallet.sk, name: null }],
  };

  localStorage.setItem(storage.KEY, JSON.stringify(newWallet));
};

@migratable(migrate)
@derivable(derive)
@updatable({ defaultState, storage })
class _PgWallet {
  /**
   * Add a new account.
   *
   * @param name name of the account
   * @param keypair optional keypair, default to a random keypair
   */
  static add(
    name: WalletAccountName,
    keypair: Keypair = this.generateKeypair()
  ) {
    // Check if account exists
    const accountIndex = PgWallet.accounts.findIndex((acc) => {
      return (
        (name && acc.name === name) ||
        Keypair.fromSecretKey(Uint8Array.from(acc.kp)).publicKey.equals(
          keypair.publicKey
        )
      );
    });
    if (accountIndex !== -1) {
      // Account exists, switch to the account
      PgWallet.switch(accountIndex);
      return;
    }

    // Add the account
    PgWallet.accounts.push({
      kp: Array.from(keypair.secretKey),
      name,
    });

    // Update the accounts
    PgWallet.update({
      accounts: PgWallet.accounts,
      currentIndex: PgWallet.accounts.length - 1,
    });
  }

  /**
   * Remove the account at the given index.
   *
   * @param index account index
   */
  static remove(index: number = PgWallet.currentIndex) {
    PgWallet.accounts.splice(index, 1);

    // Update the accounts
    PgWallet.update({
      accounts: PgWallet.accounts,
      currentIndex: PgWallet.accounts.length - 1,
    });
  }

  /**
   * Rename the account.
   *
   * @param name new name of the account
   * @param index account index
   */
  static rename(
    name: WalletAccountName,
    index: number = PgWallet.currentIndex
  ) {
    PgWallet.accounts[index].name = name;

    // Update the accounts
    PgWallet.update({ accounts: PgWallet.accounts });
  }

  /**
   * Import a keypair from the user's file system.
   *
   * @param name name of the account
   * @returns the imported keypair if importing was successful
   */
  static async import(name: WalletAccountName) {
    return await PgCommon.import(
      async (ev) => {
        const files = ev.target.files;
        if (!files?.length) return;

        try {
          const file = files[0];
          const arrayBuffer = await file.arrayBuffer();
          const decodedString = PgCommon.decodeBytes(arrayBuffer);
          const keypairBytes = Uint8Array.from(JSON.parse(decodedString));
          if (keypairBytes.length !== 64) throw new Error("Invalid keypair");

          const keypair = Keypair.fromSecretKey(keypairBytes);
          PgWallet.add(name, keypair);

          return keypair;
        } catch (err: any) {
          console.log(err.message);
        }
      },
      { accept: ".json" }
    );
  }

  /**
   * Export the given or the existing keypair to the user's file system.
   *
   * @param keypair optional keypair, defaults to the current wallet's keypair
   */
  static export(keypair?: Keypair) {
    PgCommon.export(
      "wallet-keypair.json",
      keypair ? Array.from(keypair.secretKey) : PgWallet.getKeypairBytes()
    );
  }

  /**
   * Switch to the given account index.
   *
   * @param index account index to switch to
   */
  static switch(index: number) {
    if (!PgWallet.accounts[index]) {
      throw new Error(`Account index '${index}' not found`);
    }

    PgWallet.currentIndex = index;
  }

  /** Get the keypair bytes of the current wallet. */
  static getKeypairBytes() {
    if (!PgWallet.current) throw new Error("Not connected");
    if (!PgWallet.current.isPg) throw new Error("Not Playground Wallet");

    return Array.from(PgWallet.current.keypair.secretKey);
  }

  /** Generate a random ed25519 keypair. */
  static generateKeypair() {
    return Keypair.generate();
  }
}

export const PgWallet = declareDerivable(
  declareUpdatable(_PgWallet, { defaultState }),
  derive
);