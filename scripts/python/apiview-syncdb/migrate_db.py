import sys
import argparse
import codecs
from datetime import datetime
import json
import os
import logging
import traceback
from ast import literal_eval
from azure.cosmos import CosmosClient

logging.getLogger().setLevel(logging.INFO)
http_logger = logging.getLogger("azure.core.pipeline.policies.http_logging_policy")
http_logger.setLevel(logging.WARNING)

# Script to sync cosmosdb from APIView production instance into APIView staging instance.
# This script identifies missing records by fetching ID and partitionKey from all containers in source and destination DB
# and identify ID of missing records. Script read record from source and insert into destination DB for all missing records.


COSMOS_SELECT_ID_PARTITIONKEY_QUERY = "select c.id, c.{0} as partitionKey, c._ts from {1} c"

COSMOS_CONTAINERS = ["Reviews", "Comments", ]
BACKUP_CONTAINER = "backups"
BLOB_NAME_PATTERN ="cosmos/{0}/{1}"



def update_items(dest_url, dest_key, db_name):    

    dest_db_client = get_db_client(dest_url, dest_key, db_name)
    cosmos_container_name = "Reviews"
    dest_container_client = dest_db_client.get_container_client(cosmos_container_name)
    autoReviews = 0
    prReviews = 0
    manualReviews = 0
    dest_records = dest_container_client.read_all_items(max_item_count=50)
    for rec in dest_records:
        if ("IsAutomatic" in rec and rec["IsAutomatic"] == True):
            autoReviews += 1
            rec["FilterType"] = 2
        elif("Revisions" in rec):
            rev = rec["Revisions"][-1]
            if ( "Label" in rev and rev["Label"] and "Created for PR" in rev["Label"]):
                prReviews += 1
                rec["FilterType"] = 3                
            else:
                manualReviews += 1
                rec["FilterType"] = 1 
        dest_container_client.upsert_item(rec)
    print("Auto review: {0}, PR reviews: {1} Manual reviews: {2}".format(autoReviews, prReviews, manualReviews))
    #dest_container_client.upsert_item(row)



# Create cosmosdb clients
def get_db_client(dest_url, dest_key, db_name):

    # Create cosmosdb client for destination db
    dest_cosmos_client = CosmosClient(dest_url, credential=dest_key)
    if not dest_cosmos_client:
        logging.error("Failed to create cosmos client for destination db")
        exit(1)

    logging.info("Created cosmos client for destination cosmosdb")
    # Create database client object using CosmosClient
    dest_db_client = None
    try:
        dest_db_client = dest_cosmos_client.get_database_client(db_name)
        logging.info("Created database clients")
    except:
        logging.error("Failed to create databae client using CosmosClient")
        traceback.print_exc()
        exit(1)
    return dest_db_client


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Sync Azure cosmosDB from source DB instance to destination DB instance"
    )
    
    parser.add_argument(
        "--url",
        required=True,
        help=("URL to cosmosdb"),
    )
    parser.add_argument(
        "--key",
        required=True,
        help=("cosmosdb account key"),
    )
    parser.add_argument(
        "--db-name",
        required=True,
        help=("Database name in cosmosdb"),
    )

    args = parser.parse_args()

    logging.info("migrating database..")
    update_items(args.url, args.key, args.db_name)