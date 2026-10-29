import { InMemorySandboxStore } from "../../src/index.js";
import { describeStoreContract } from "../contracts/store-contract.js";

describeStoreContract("InMemorySandboxStore", async () => ({ store: new InMemorySandboxStore() }));
