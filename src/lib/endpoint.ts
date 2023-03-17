import { toHex } from '@cosmjs/encoding';
import { logs } from '@cosmjs/stargate';
import { tendermint34 } from '@cosmjs/tendermint-rpc';
import { Packet } from 'cosmjs-types/ibc/core/channel/v1/channel';

import { IbcClient } from './ibcclient';
import {
  Ack,
  parseAcksFromLogs,
  parsePacketsFromBlockResult,
  parsePacketsFromEvents,
} from './utils';

export interface PacketWithMetadata {
  packet: Packet;
  // block it was in, must query proofs >= height
  height: number;
}

export type AckWithMetadata = Ack & {
  // block the ack was in, must query proofs >= height
  height: number;
  /**
   * The hash of the transaction in which the ack was found.
   * Encoded as upper case hex.
   */
  txHash: string;
};

export interface QueryOpts {
  minHeight?: number;
  maxHeight?: number;
  sequence?: number;
}

/**
 * Endpoint is a wrapper around SigningStargateClient as well as ClientID
 * and ConnectionID. Two Endpoints compose a Link and this should expose all the
 * methods you need to work on one half of an IBC Connection, the higher-level
 * orchestration is handled in Link.
 */
export class Endpoint {
  public readonly client: IbcClient;
  public readonly clientID: string;
  public readonly connectionID: string;

  public constructor(
    client: IbcClient,
    clientID: string,
    connectionID: string
  ) {
    this.client = client;
    this.clientID = clientID;
    this.connectionID = connectionID;
  }

  public chainId(): string {
    return this.client.chainId;
  }

  public async getLatestCommit(): Promise<tendermint34.CommitResponse> {
    return this.client.getCommit();
  }

  private async getPacketsFromBlockEvents({
    minHeight,
    maxHeight,
    sequence,
  }: QueryOpts = {}): Promise<PacketWithMetadata[]> {
    let query = `send_packet.packet_connection='${this.connectionID}'`;
    if (sequence) {
      query = `${query} AND send_packet.packet_sequence='${sequence}'`;
    }

    if (minHeight) {
      query = `${query} AND block.height>=${minHeight}`;
    }
    if (maxHeight) {
      query = `${query} AND block.height<=${maxHeight}`;
    }

    const search = await this.client.tm.blockSearchAll({ query });
    const resultsNested = await Promise.all(
      search.blocks.map(async ({ block }) => {
        const height = block.header.height;
        const result = await this.client.tm.blockResults(height);
        return parsePacketsFromBlockResult(result).map((packet) => ({
          packet,
          height,
          sender: '',
        }));
      })
    );

    return ([] as PacketWithMetadata[]).concat(...resultsNested);
  }

  private async getPacketsFromTxs({
    minHeight,
    maxHeight,
    sequence,
  }: QueryOpts = {}): Promise<PacketWithMetadata[]> {
    let query = `send_packet.packet_connection='${this.connectionID}'`;
    if (sequence) {
      query = `${query} AND send_packet.packet_sequence='${sequence}'`;
    }
    if (minHeight) {
      query = `${query} AND tx.height>=${minHeight}`;
    }
    if (maxHeight) {
      query = `${query} AND tx.height<=${maxHeight}`;
    }

    const search = await this.client.tm.txSearchAll({ query });
    const resultsNested = search.txs.map(
      ({ height, result }): PacketWithMetadata[] =>
        parsePacketsFromEvents(result.events).map((packet) => ({
          packet,
          height,
        }))
    );
    return resultsNested.flat();
  }

  // returns all packets (auto-paginates, so be careful about not setting a minHeight)
  public async querySentPackets({
    minHeight,
    maxHeight,
    sequence,
  }: QueryOpts = {}): Promise<PacketWithMetadata[]> {
    const txsPackets = await this.getPacketsFromTxs({ minHeight, maxHeight, sequence });
    const eventsPackets = await this.getPacketsFromBlockEvents({
      minHeight,
      maxHeight,
      sequence,
    });
    return ([] as PacketWithMetadata[])
      .concat(...txsPackets)
      .concat(...eventsPackets);
  }

  // returns all acks (auto-paginates, so be careful about not setting a minHeight)
  public async queryWrittenAcks({
    minHeight,
    maxHeight,
    sequence,
  }: QueryOpts = {}): Promise<AckWithMetadata[]> {
    let query = `write_acknowledgement.packet_connection='${this.connectionID}'`;
    if (sequence) {
      query = `${query} AND write_acknowledgement.packet_sequence='${sequence}'`;
    }
    if (minHeight) {
      query = `${query} AND tx.height>=${minHeight}`;
    }
    if (maxHeight) {
      query = `${query} AND tx.height<=${maxHeight}`;
    }

    const search = await this.client.tm.txSearchAll({ query });
    const out = search.txs.flatMap(({ height, result, hash }) => {
      const parsedLogs = logs.parseRawLog(result.log);
      // const sender = logs.findAttribute(parsedLogs, 'message', 'sender').value;
      return parseAcksFromLogs(parsedLogs).map(
        (ack): AckWithMetadata => ({
          height,
          txHash: toHex(hash).toUpperCase(),
          ...ack,
        })
      );
    });
    return out;
  }
}

/**
 * Requires a match of any set field
 *
 * This is designed to easily produce search/subscription query strings,
 * not principally for in-memory filtering.
 */
export interface Filter {
  readonly srcPortId?: string;
  readonly srcChannelId?: string;
  readonly destPortId?: string;
  readonly destChannelId?: string;
}
