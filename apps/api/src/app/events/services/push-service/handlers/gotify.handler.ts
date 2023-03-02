import { ChannelTypeEnum } from '@novu/shared';
import { GotifyPushProvider } from '@novu/gotify';
import { BasePushHandler } from './base.handler';
import { ICredentials } from '@novu/dal';

export class GotifyHandler extends BasePushHandler {
  constructor() {
    super('gotify', ChannelTypeEnum.PUSH);
  }

  buildProvider(credentials: ICredentials) {
    if (!credentials.host || !credentials.token || !credentials.port) {
      throw new Error('Config is not valid for gotify');
    }
    this.provider = new GotifyPushProvider({
      host: credentials.host,
      port: credentials.port,
      appToken: credentials.token,
    });
  }
}
