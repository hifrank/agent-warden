import { CosmosClient, Database } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";

let _db: Database | undefined;

export async function getCosmosDb(
  endpoint: string,
  databaseName: string
): Promise<Database> {
  if (_db) return _db;

  const credential = new DefaultAzureCredential();
  const client = new CosmosClient({ endpoint, aadCredentials: credential });
  _db = client.database(databaseName);
  return _db;
}
