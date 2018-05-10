import { inject, injectable } from 'inversify'
import { Collection, Db } from 'mongodb'
import * as Pino from 'pino'
import { Claim, isClaim, ClaimIdIPFSHashPair } from 'poet-js'

import { childWithFileName } from 'Helpers/Logging'
import { Exchange } from 'Messaging/Messages'
import { Messaging } from 'Messaging/Messaging'
import { Entry } from './Entry'

import { IPFS } from './IPFS'

@injectable()
export class ClaimController {
  private readonly logger: Pino.Logger
  private readonly db: Db
  private readonly collection: Collection
  private readonly messaging: Messaging
  private readonly ipfs: IPFS

  constructor(
    @inject('Logger') logger: Pino.Logger,
    @inject('DB') db: Db,
    @inject('Messaging') messaging: Messaging,
    @inject('IPFS') ipfs: IPFS
  ) {
    this.logger = childWithFileName(logger, __filename)
    this.db = db
    this.collection = this.db.collection('storage')
    this.messaging = messaging
    this.ipfs = ipfs
  }

  async create(claim: Claim): Promise<void> {
    const logger = this.logger.child({ method: 'create' })

    logger.trace({ claim }, 'Storing Claim')

    const ipfsHash = await this.ipfs.addText(JSON.stringify(claim))

    logger.info({ claim, ipfsHash }, 'Claim Stored')

    await this.collection.insertOne({
      claimId: claim.id,
      ipfsHash,
    })
    await this.messaging.publish(Exchange.ClaimIPFSHash, {
      claimId: claim.id,
      ipfsHash,
    })
  }

  async download(ipfsHashes: ReadonlyArray<string>) {
    const logger = this.logger.child({ method: 'download' })

    logger.trace({ ipfsHashes }, 'Downloading Claims')
    await this.collection.insertMany(
      ipfsHashes.map((ipfsHash): Entry => ({
        ipfsHash,
        claimId: null,
        lastDownloadAttempt: null,
        lastDownloadSuccess: null,
        downloadAttempts: 0,
      })),
      { ordered: false }
    )
  }

  async updateEntryPairs({ entry, claim, ...rest }: { claim: Claim; entry: Entry }) {
    const logger = this.logger.child({ method: 'publishEntryDownload' })
    logger.trace('started claim update has pairs')
    this.updateClaimIdIPFSHashPairs([
      {
        claimId: claim.id,
        ipfsHash: entry.ipfsHash,
      },
    ])
    logger.trace('finished claim update has pairs')
    return {
      claim,
      entry,
      ...rest,
    }
  }

  async publishEntryDownload({ entry, claim, ...rest }: { claim: Claim; entry: Entry }) {
    const logger = this.logger.child({ method: 'publishEntryDownload' })
    logger.trace('started claim publishing')
    await this.messaging.publishClaimsDownloaded([
      {
        claim,
        ipfsHash: entry.ipfsHash,
      },
    ])
    logger.trace('finished claim publishing')
    return {
      claim,
      entry,
      ...rest,
    }
  }

  async downloadEntryClaim({ entry, ...rest }: { entry: Entry }) {
    const logger = this.logger.child({ method: 'downloadEntryClaim' })
    logger.trace('starting claim download')
    const claim = await this.downloadClaim(entry.ipfsHash)
    logger.trace('finished claim download', claim)
    return {
      entry,
      claim,
      ...rest,
    }
  }

  async findEntryToDownload({
    currentTime = new Date().getTime(),
    retryDelay,
    maxAttempts,
    ...rest
  }: {
    currentTime?: number
    retryDelay: number
    maxAttempts: number
  }) {
    const logger = this.logger.child({ method: 'findEntryToDownload' })
    logger.info('started finding claim')
    const entry = await this.collection.findOne({
      claimId: null,
      ipfsHash: { $exists: true },
      $and: [
        {
          $or: [
            { lastDownloadAttempt: null },
            { lastDownloadAttempt: { $exists: false } },
            { lastDownloadAttempt: { $lt: currentTime - retryDelay } },
          ],
        },
        {
          $or: [{ lastDownloadSuccess: null }, { lastDownloadSuccess: { $exists: false } }],
        },
        {
          $or: [
            { downloadAttempts: null },
            { downloadAttempts: { $exists: false } },
            { downloadAttempts: { $lte: maxAttempts } },
          ],
        },
      ],
    })
    logger.info('finished finding claim', entry)
    return {
      currentTime,
      retryDelay,
      maxAttempts,
      entry,
      ...rest,
    }
  }

  async updateEntryAttempts({
    entry,
    currentTime = new Date().getTime(),
    ...rest
  }: {
    entry: Entry
    currentTime?: number
  }) {
    const logger = this.logger.child({ method: 'updateEntryAttempts' })
    logger.trace('started updating claim')
    await this.collection.updateOne(
      {
        _id: entry._id,
      },
      {
        $set: { lastDownloadAttempt: currentTime },
        $inc: { downloadAttempts: 1 },
      }
    )
    logger.trace('finished updating claim')
    return {
      entry,
      currentTime,
      ...rest,
    }
  }

  async downloadNextHash({ retryDelay = 600000, maxAttempts = 20 }: { retryDelay: number; maxAttempts: number }) {
    return this.findEntryToDownload({ retryDelay, maxAttempts })
      .then(this.updateEntryAttempts.bind(this))
      .then(this.downloadEntryClaim.bind(this))
      .then(this.updateEntryPairs.bind(this))
      .then(this.publishEntryDownload.bind(this))
  }

  private downloadClaim = async (ipfsHash: string): Promise<Claim> => {
    const text = await this.ipfs.cat(ipfsHash)
    const claim = JSON.parse(text)

    if (!isClaim(claim)) throw new Error('Unrecognized claim')

    return claim
  }

  private async updateClaimIdIPFSHashPairs(claimIdIPFSHashPairs: ReadonlyArray<ClaimIdIPFSHashPair>) {
    const logger = this.logger.child({ method: 'updateClaimIdIPFSHashPairs' })

    logger.trace({ claimIdIPFSHashPairs }, 'Storing { claimId, ipfsHash } pairs in the DB.')

    const results = await Promise.all(
      claimIdIPFSHashPairs.map(({ claimId, ipfsHash }) =>
        this.collection.updateOne({ ipfsHash }, { $set: { claimId } }, { upsert: true })
      )
    )

    const databaseErrors = results.filter(_ => _.result.n !== 1)

    if (databaseErrors.length) logger.error({ databaseErrors }, 'Error storing { claimId, ipfsHash } pairs in the DB.')

    logger.trace({ claimIdIPFSHashPairs }, 'Storing { claimId, ipfsHash } pairs in the DB successfully.')
  }
}
