/**
 * Cosmos DB client — singleton, lazily initialized.
 * Uses DefaultAzureCredential (same pattern as agent-warden-server).
 */
import { CosmosClient, type Database, type Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

let _db: Database | undefined;

export async function getCosmosDb(
  endpoint: string,
  databaseName: string,
): Promise<Database> {
  if (_db) return _db;

  const credential = new DefaultAzureCredential();
  const client = new CosmosClient({ endpoint, aadCredentials: credential });
  _db = client.database(databaseName);
  return _db;
}

export async function getContainer(
  endpoint: string,
  databaseName: string,
  containerName: string,
): Promise<Container> {
  const db = await getCosmosDb(endpoint, databaseName);
  return db.container(containerName);
}
