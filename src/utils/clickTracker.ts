import Taro from '@tarojs/taro';

export interface ClickRecord {
  offset: [string, string]; // 百分比格式的坐标
  url: string;
  flag: string;
}

export interface ClickTrackerConfig {
  storageKey?: string;
  audioBaseUrl?: string;
  audioIndexStart?: number;
  offsetX?: number;
  offsetY?: number;
  widthAdjustment?: number;
  heightAdjustment?: number;
}

export class ClickTracker {
  private config: ClickTrackerConfig;
  private audioIndex: number;
  private clickRecords: Record<number, ClickRecord[]> = {};

  constructor(config: ClickTrackerConfig = {}) {
    this.config = {
      storageKey: 'book_click_records',
      // 默认音频基础URL
      audioBaseUrl: '',
      // 默认音频索引起始值
      audioIndexStart: 17,
      // 默认偏移量和调整比例——图标为15x15像素，图片实际尺寸为300x300像素
      offsetX: 28, //15,
      offsetY: 29, //15,
      // 根据偏移量配平
      widthAdjustment: 0.037,
      heightAdjustment: 0.135,//0.165,
      ...config
    };
    
    this.audioIndex = this.config.audioIndexStart!;
    this.loadRecords();
  }

  private loadRecords() {
    try {
      const records = Taro.getStorageSync(this.config.storageKey!);
      if (records) {
        this.clickRecords = records;
      }
    } catch (error) {
      console.warn('Failed to load click records:', error);
    }
  }

  private saveRecords() {
    try {
      Taro.setStorageSync(this.config.storageKey!, this.clickRecords);
    } catch (error) {
      console.warn('Failed to save click records:', error);
    }
  }

  /**
   * 处理图片点击事件
   */
  handleImageClick = (e: any, currentPage: number) => {
    // 获取图片在页面上的实际宽高
    Taro.createSelectorQuery()
      .select('.book-page')
      .boundingClientRect(rect => {
        // rect 可能是数组或对象，需判断
        const r = Array.isArray(rect) ? rect[0] : rect;
        if (r && r.width && r.height) {
          // e.detail.x/y 是点击点相对图片左上角的像素
          const { x, y } = e.detail;

          // 添加调试信息
          console.log('点击坐标:', { x, y });
          console.log('图片尺寸:', { width: r.width, height: r.height });

          const ratioX = (x - this.config.offsetX!) / r.width  + this.config.widthAdjustment!;
          const ratioY = (y - this.config.offsetY!) / r.height - this.config.heightAdjustment!;

          console.log('计算比例:', { ratioX, ratioY });

          const record: ClickRecord = {
            offset: [`"${(ratioX * 100).toFixed(0)}%"`, `"${(ratioY * 100).toFixed(0)}%"`],
            url: `${this.config.audioBaseUrl}${this.audioIndex.toFixed(0)}.mp3`,
            flag: "Percentage",
          };

          // 更新记录
          if (!this.clickRecords[currentPage + 2]) {
            this.clickRecords[currentPage + 2] = [];
          }
          this.clickRecords[currentPage + 2].push(record);
          this.saveRecords();

          // 更新audioIndex，下次点击时使用新的数字
          this.audioIndex++;

          Taro.showToast({
            title: `第${currentPage + 2}页: x=${(ratioX * 100).toFixed(1)}%, y=${(ratioY * 100).toFixed(1)}%`,
            icon: 'none'
          });
        }
      })
      .exec();
  };

  /**
   * 导出记录
   */
  exportRecords = () => {
    const records = this.clickRecords;

    // 自定义格式化，去掉引号，offset不换行
    const formatRecord = (record: ClickRecord) => {
      return `{
        offset: [${record.offset[0]}, ${record.offset[1]}],
        url: '${record.url}',
        flag: "${record.flag}",
      }`;
    };

    const formatPage = (pageNum: string, records: ClickRecord[]) => {
      const formattedRecords = records.map(formatRecord).join(',\n        ');
      return `${pageNum}: [\n        ${formattedRecords}\n    ]`;
    };

    const pages = Object.keys(records).map(pageNum =>
      formatPage(pageNum, records[pageNum])
    ).join(',\n    ');

    const output = `{\n    ${pages}\n}`;
    Taro.setClipboardData({ data: output });
    Taro.showToast({ title: '已复制到剪贴板', icon: 'none' });
  };

  /**
   * 清除所有记录
   */
  clearRecords = () => {
    this.clickRecords = {};
    this.audioIndex = this.config.audioIndexStart!;
    this.saveRecords();
    Taro.showToast({ title: '记录已清除', icon: 'success' });
  };

  /**
   * 获取当前记录
   */
  getRecords = () => {
    return { ...this.clickRecords };
  };

  /**
   * 重置音频索引
   */
  resetAudioIndex = (startIndex?: number) => {
    this.audioIndex = startIndex || this.config.audioIndexStart!;
  };
}

// 创建默认实例
export const clickTracker = new ClickTracker();

// 导出便捷函数
export const createClickTracker = (config?: ClickTrackerConfig) => {
  return new ClickTracker(config);
}; 