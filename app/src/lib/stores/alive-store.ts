import { AccountsStore } from './accounts-store'
import { Account, accountEquals } from '../../models/account'
import { API } from '../api'
import AliveSession, { AliveEvent } from '../alive/alive-session'
import { Subscription } from '../alive/subscription-set'
import { Emitter } from 'event-kit'

function accountIncluded(account: Account, accounts: ReadonlyArray<Account>) {
  return accounts.find(a => accountEquals(a, account))
}

interface IAliveSubscription {
  readonly account: Account
  readonly subscription: Subscription<AliveStore>
}

interface IAliveEndpointSession {
  readonly session: AliveSession<AliveStore>
  readonly webSocketUrl: string
}

export class AliveStore {
  private readonly ALIVE_EVENT_RECEIVED_EVENT = 'alive-event-received'

  private sessionPerEndpoint: Map<string, IAliveEndpointSession> = new Map()
  private subscriptions: Array<IAliveSubscription> = []
  private readonly emitter = new Emitter()

  public constructor(private readonly accountsStore: AccountsStore) {
    this.accountsStore.onDidUpdate(this.subscribeToAccounts)
  }

  private subscribeToAccounts = (accounts: ReadonlyArray<Account>) => {
    const subscribedAccounts = this.subscriptions.map(s => s.account)

    for (const account of subscribedAccounts) {
      if (!accountIncluded(account, accounts)) {
        this.unsubscribeFromAccount(account)
      }
    }

    for (const account of accounts) {
      if (!accountIncluded(account, subscribedAccounts)) {
        this.subscribeToAccount(account)
      }
    }
  }

  private sessionForAccount(
    account: Account
  ): IAliveEndpointSession | undefined {
    return this.sessionPerEndpoint.get(account.endpoint)
  }

  private async createSessionForAccount(
    account: Account
  ): Promise<IAliveEndpointSession | null> {
    const session = this.sessionForAccount(account)
    if (session !== undefined) {
      return session
    }

    const api = API.fromAccount(account)
    const webSocketUrl = await api.getAliveWebSocket()

    if (webSocketUrl === null) {
      return null
    }

    const aliveSession = new AliveSession(
      webSocketUrl,
      webSocketUrl,
      false,
      this.notify
    )

    const newSession = {
      session: aliveSession,
      webSocketUrl,
    }

    this.sessionPerEndpoint.set(account.endpoint, newSession)

    return newSession
  }

  private unsubscribeFromAccount(account: Account) {
    const endpointSession = this.sessionForAccount(account)
    if (endpointSession === undefined) {
      return
    }

    const subscription = this.subscriptions.find(s =>
      accountEquals(s.account, account)
    )
    if (subscription === undefined) {
      return
    }

    endpointSession.session.unsubscribe([subscription.subscription])
    this.subscriptions = this.subscriptions.filter(
      s => !accountEquals(s.account, account)
    )
  }

  private subscribeToAccount = async (account: Account) => {
    const endpointSession = await this.createSessionForAccount(account)
    const api = API.fromAccount(account)
    const channelInfo = await api.getAliveDesktopChannel()

    if (endpointSession === null || channelInfo === null) {
      return
    }

    const subscription = {
      subscriber: this,
      topic: {
        name: channelInfo.channel_name,
        signed: channelInfo.signed_channel,
        offset: '', // TODO: do we need to set an offset?
      },
    }

    endpointSession.session.subscribe([subscription])

    this.subscriptions.push({
      account,
      subscription,
    })

    console.log('Subscribed to Alive channel!')
  }

  private notify = (subscribers: Iterable<AliveStore>, event: AliveEvent) => {
    console.log('Alive event received:', event)

    if (event.type !== 'message') {
      return
    }

    this.emitter.emit(this.ALIVE_EVENT_RECEIVED_EVENT, event)
  }

  public onNotificationReceived(callback: (event: AliveEvent) => void) {
    this.emitter.on(this.ALIVE_EVENT_RECEIVED_EVENT, callback)
  }
}