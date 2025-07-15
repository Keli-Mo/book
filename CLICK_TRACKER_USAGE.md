# 点击追踪工具使用说明

## 概述

`clickTracker` 是一个独立的图片点击坐标记录工具，可以方便地集成到任何需要记录图片点击位置的项目中。

## 功能特性

- ✅ 记录图片点击坐标（百分比格式）
- ✅ 自动生成音频URL
- ✅ 本地存储记录
- ✅ 导出格式化数据
- ✅ 可配置参数
- ✅ 易于集成和移除

## 快速开始

### 1. 基本使用

```typescript
import { clickTracker } from '@/utils/clickTracker';

// 在组件中使用
const handleImageClick = (e) => {
  clickTracker.handleImageClick(e, currentPage);
};

const exportRecords = () => {
  clickTracker.exportRecords();
};
```

### 2. 自定义配置

```typescript
import { createClickTracker } from '@/utils/clickTracker';

// 创建自定义实例
const customTracker = createClickTracker({
  storageKey: 'custom_click_records',
  audioBaseUrl: 'https://your-domain.com/audio/',
  audioIndexStart: 1,
  offsetX: 10,
  offsetY: 10,
  heightAdjustment: 0.1
});
```

## 配置参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `storageKey` | string | 'book_click_records' | 本地存储的键名 |
| `audioBaseUrl` | string | 腾讯云音频URL | 音频文件的基础URL |
| `audioIndexStart` | number | 2 | 音频索引起始值 |
| `offsetX` | number | 15 | X轴偏移量 |
| `offsetY` | number | 15 | Y轴偏移量 |
| `heightAdjustment` | number | 0.165 | 高度调整系数 |

## API 方法

### handleImageClick(e, currentPage)
处理图片点击事件，记录坐标信息。

**参数：**
- `e`: 点击事件对象
- `currentPage`: 当前页面索引

### exportRecords()
导出所有记录到剪贴板。

### clearRecords()
清除所有记录。

### getRecords()
获取当前所有记录。

### resetAudioIndex(startIndex?)
重置音频索引。

**参数：**
- `startIndex`: 可选的起始索引值

## 集成示例

### 在 BookPreview 组件中集成

```typescript
import { clickTracker } from '@/utils/clickTracker';

const BookPreview = () => {
  // 处理图片点击
  const handleImageClick = (e) => {
    clickTracker.handleImageClick(e, currentPage);
  };

  // 导出记录
  const exportRecords = () => {
    clickTracker.exportRecords();
  };

  return (
    <View>
      <Image 
        src={url} 
        onClick={handleImageClick}
        className="book-page"
      />
      <Button onClick={exportRecords}>导出记录</Button>
    </View>
  );
};
```

### 在任意组件中使用

```typescript
import { createClickTracker } from '@/utils/clickTracker';

const MyComponent = () => {
  // 创建专用实例
  const tracker = createClickTracker({
    storageKey: 'my_component_records',
    audioBaseUrl: 'https://my-domain.com/audio/',
    audioIndexStart: 1
  });

  const handleClick = (e) => {
    tracker.handleImageClick(e, 0);
  };

  const exportData = () => {
    tracker.exportRecords();
  };

  return (
    <View>
      <Image src="image.jpg" onClick={handleClick} />
      <Button onClick={exportData}>导出</Button>
    </View>
  );
};
```



## 输出格式

导出的数据格式如下：

```javascript
{
    2: [
        {
          offset: ["25%", "30%"],
          url: 'https://domain.com/audio/2.mp3',
          flag: "Percentage",
        },
        {
          offset: ["60%", "45%"],
          url: 'https://domain.com/audio/3.mp3',
          flag: "Percentage",
        }
    ],
    3: [
        {
          offset: ["40%", "20%"],
          url: 'https://domain.com/audio/4.mp3',
          flag: "Percentage",
        }
    ]
}
```

## 注意事项

1. **坐标计算**：坐标会自动转换为百分比格式，便于跨设备使用
2. **存储限制**：使用本地存储，注意数据量大小
3. **音频URL**：确保音频文件URL格式正确
4. **错误处理**：工具内置了基本的错误处理机制

## 扩展功能

可以根据需要扩展以下功能：

- 支持多种坐标格式
- 添加时间戳记录
- 支持批量导入/导出
- 添加数据验证
- 支持云端同步

## 故障排除

### 常见问题

1. **坐标不准确**
   - 检查 `offsetX` 和 `offsetY` 参数
   - 调整 `heightAdjustment` 值

2. **音频URL错误**
   - 确认 `audioBaseUrl` 格式正确
   - 检查音频文件是否存在

3. **存储失败**
   - 检查存储空间是否充足
   - 确认 `storageKey` 唯一性

### 调试模式

启用调试信息：
```typescript
// 在控制台查看详细日志
console.log('点击坐标:', { x, y });
console.log('图片尺寸:', { width: r.width, height: r.height });
console.log('计算比例:', { ratioX, ratioY });
``` 