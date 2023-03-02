import {
  ChannelTypeEnum,
  ISendMessageSuccessResponse,
  IPushOptions,
  IPushProvider,
} from '@novu/stateless';
import axios from 'axios';

export class GotifyPushProvider implements IPushProvider {
  id = 'gotify';
  apiBaseUrl = '';
  channelType = ChannelTypeEnum.PUSH as ChannelTypeEnum.PUSH;

  constructor(
    private config: {
      host: string;
      port: string;
      appToken: string;
    }
  ) {
    this.apiBaseUrl = `http://${config.host}:${config.port}`;
  }

  async sendMessage(
    options: IPushOptions
  ): Promise<ISendMessageSuccessResponse> {
    const url = this.apiBaseUrl + '/message?token=' + this.config.appToken;
    const response = await axios.post(url, {
      message: options.content,
      priority: 5,
      title: options.title,
    });

    return {
      id: response.data?.id,
      date: response.data?.date || new Date().toDateString(),
    };
  }
}
