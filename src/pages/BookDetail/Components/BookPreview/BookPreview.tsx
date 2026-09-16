import React, { useState, useEffect, useRef } from "react";
import Taro, { useRouter } from "@tarojs/taro";
import { AtFloatLayout, AtList, AtListItem, AtIcon } from "taro-ui"
import { Swiper, SwiperItem, Image, View, Text } from "@tarojs/components";
import { catalogLists } from "./constants/catalogList";
import { allAudioList } from "./constants/audioList";
import { concatImages } from "./constants/images";

// //插件
// import { clickTracker } from "@/utils/clickTracker";
//不是插件,保持注释
// import "@taroify/core/icon/style"

import "./BookPreview.scss";
const green = "rgb(66, 134, 135)"
const gray = 'rgb(67, 83, 108)'

const decimalToPercentage = (decimal) => {
  return (decimal * 100).toFixed(2) + '%';
}

interface IBookPreviewProps {
  id: string;
  currentPage: number;
  setCurrentPage: (v: number) => void
}

const titleMap = {
  1:  '原版教材+剑桥考试课程',
  2:  '海沙课程',
  3:  'CASA阅读启蒙&自然拼读 1',
  4:  'CASA阅读启蒙&自然拼读 2',
  5:  'CASA阅读启蒙&自然拼读 3',
  6:  'CASA阅读启蒙&自然拼读 4',
  7:  '剑桥PET学生用书',
  8:  '剑桥PET练习册',
  9:  '剑桥KET学生用书',
  10: '剑桥KET练习册',
  11: 'Our World L1 学生用书',
  12: 'Our World L1 练习册',
  13: 'Our World Starter 学生用书',
  14: 'Our World Starter 练习册',
  15: 'OD 1',
  16: 'OD 2',
  17: 'OD 3',
  18: 'OD 4',
  19: 'OD 5',
  20: 'RE 1',
  21: 'RE 2',
  22: 'RE 3',
  23: 'RE 4',
  24: 'RE 5',
}

/*
  1. bookTypeMap[id] 为 true 表示该类型书籍（如学生用书）存在封面和目录页，不应计入页码中。
    - 页码从第 2 页开始显示（currentPage > 1）
    - 页码显示为 "(当前页 - 1) / (总页数 - 2)"，扣除封面和目录页。
    - 第 1 页（封面或目录）则不显示页码。

  2. bookTypeMap[id] 为 false 表示该类型书籍（如广告页或介绍页）不扣除封面和目录页。
    - 页码从第 1 页开始全部计算，直接显示 "当前页 + 1 / 总页数"。
*/

enum EBookType {
  HAISHA_ADVERTISEMENT      = "1",
  HAISHA_INTRODUCTION       = "2",
  READING_BOOK_1            = "3",
  READING_BOOK_2            = "4",
  READING_BOOK_3            = "5",
  READING_BOOK_4            = "6",
  PET_STUDENT_BOOK_B1       = "7",
  PET_PRACTICE_BOOK_B1      = "8",
  KET_STUDENT_BOOK_A2       = "9",
  KET_PRACTICE_BOOK_A2      = "10",
  OW_STUDENT_BOOK_L1        = "11",
  OW_PRACTICE_BOOK_L1       = "12",
  OW_STUDENT_BOOK_STARTER   = "13",
  OW_PRACTICE_BOOK_STARTER  = "14",
  OD_DICSOVER_1ST_EDITION   = "15",
  OD_DICSOVER_2ND_EDITION   = "16",
  OD_DICSOVER_3RD_EDITION   = "17",
  OD_DICSOVER_4TH_EDITION   = "18",
  OD_DICSOVER_5TH_EDITION   = "19",
  RE_FOUNDATIONS_STUDENT_BOOK    = "20",
  RE_L1_STUDENT_BOOK        = "21",
  RE_L2_STUDENT_BOOK        = "22",
  RE_L3_STUDENT_BOOK        = "23",
  RE_L4_STUDENT_BOOK        = "24",
  RE_L5_STUDENT_BOOK        = "25",
}

// 定义一个新的类型枚举，来表示页码显示策略
enum PageNumberingStrategy {
  ///EXCLUDE_COVER_AND_TOC = "exclude_cover_and_toc",  // 不计入封面和目录页
  INCLUDE_ALL_PAGE = "include_all_page",            // 所有页都计入
  EXCLUDE_COVER = "exclude_cover",                  // 页码排除封面   // OD  系列从封面后一页开始计算
  EXCLUDE_COVER_START_FROM_THIRD = "exclude_cover_start_from_third", // 从第三页开始计数（如 OW 系列）
  //CUSTOM = "custom",                              // 自定义策略
}

const bookPageStrategyMap: Record<EBookType, PageNumberingStrategy> = {
  [EBookType.HAISHA_ADVERTISEMENT]: PageNumberingStrategy.INCLUDE_ALL_PAGE,
  [EBookType.HAISHA_INTRODUCTION]: PageNumberingStrategy.INCLUDE_ALL_PAGE,

  [EBookType.READING_BOOK_1]: PageNumberingStrategy.EXCLUDE_COVER_START_FROM_THIRD,
  [EBookType.READING_BOOK_2]: PageNumberingStrategy.EXCLUDE_COVER_START_FROM_THIRD,
  [EBookType.READING_BOOK_3]: PageNumberingStrategy.EXCLUDE_COVER_START_FROM_THIRD,
  [EBookType.READING_BOOK_4]: PageNumberingStrategy.EXCLUDE_COVER_START_FROM_THIRD,
  [EBookType.PET_STUDENT_BOOK_B1]: PageNumberingStrategy.EXCLUDE_COVER_START_FROM_THIRD,
  [EBookType.PET_PRACTICE_BOOK_B1]: PageNumberingStrategy.EXCLUDE_COVER,
  [EBookType.KET_STUDENT_BOOK_A2]: PageNumberingStrategy.EXCLUDE_COVER,
  [EBookType.KET_PRACTICE_BOOK_A2]: PageNumberingStrategy.EXCLUDE_COVER,

  [EBookType.OW_STUDENT_BOOK_L1]: PageNumberingStrategy.EXCLUDE_COVER,
  [EBookType.OW_PRACTICE_BOOK_L1]: PageNumberingStrategy.EXCLUDE_COVER,
  [EBookType.OW_STUDENT_BOOK_STARTER]: PageNumberingStrategy.EXCLUDE_COVER,
  [EBookType.OW_PRACTICE_BOOK_STARTER]: PageNumberingStrategy.EXCLUDE_COVER,

  [EBookType.OD_DICSOVER_1ST_EDITION]: PageNumberingStrategy.EXCLUDE_COVER,
  [EBookType.OD_DICSOVER_2ND_EDITION]: PageNumberingStrategy.EXCLUDE_COVER,
  [EBookType.OD_DICSOVER_3RD_EDITION]: PageNumberingStrategy.EXCLUDE_COVER,
  [EBookType.OD_DICSOVER_4TH_EDITION]: PageNumberingStrategy.EXCLUDE_COVER,
  [EBookType.OD_DICSOVER_5TH_EDITION]: PageNumberingStrategy.EXCLUDE_COVER,

  [EBookType.RE_FOUNDATIONS_STUDENT_BOOK]: PageNumberingStrategy.EXCLUDE_COVER,
  [EBookType.RE_L1_STUDENT_BOOK]: PageNumberingStrategy.EXCLUDE_COVER,
  [EBookType.RE_L2_STUDENT_BOOK]: PageNumberingStrategy.EXCLUDE_COVER,

  [EBookType.RE_L3_STUDENT_BOOK]: PageNumberingStrategy.EXCLUDE_COVER,
  [EBookType.RE_L4_STUDENT_BOOK]: PageNumberingStrategy.EXCLUDE_COVER,
  [EBookType.RE_L5_STUDENT_BOOK]: PageNumberingStrategy.EXCLUDE_COVER,
}

const BookPreview: React.FC<IBookPreviewProps> = ({ id = "1", currentPage, setCurrentPage }) => {
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [catalogList, setCatalogList] = useState([])
  const [audioList, setAudioList] = useState({})
  const [showTopBar, setShowTopBar] = useState(false);
  const [showBottomBar, setShowBottomBar] = useState(false);
  const [catalogVisible, setCatalogVisible] = useState(false);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false); // 当前是否有音频正在播放
  const [isAudioPaused, setIsAudioPaused] = useState(false); // 新增状态，区分暂停
  const [playbackRate, setPlaybackRate] = useState(1.0); // 新增：播放速度状态
  const [isLoopEnabled, setIsLoopEnabled] = useState(true); // 新增：循环播放开关
  const [systemInfo, setSystemInfo] = useState("iPhone 12");
  const audioContextRef = useRef<Taro.InnerAudioContext>(Taro.createInnerAudioContext())
  const router = useRouter();
  const [panelPos, setPanelPos] = useState({ left: 10, top: 10 }); // 新增：控制面板整体位置
  const dragInfo = useRef({
    dragging: false,
    startX: 0,
    startY: 0,
    originLeft: 0,
    originTop: 0
  });
  const renderPageNumber = () => {
    switch (bookPageStrategyMap[id]) {
      // case PageNumberingStrategy.EXCLUDE_COVER_AND_TOC:
      //   return (currentPage > 1 ? (<View className="page-number">{(currentPage - 1) + ' / ' + (imageUrls.length - 2)}</View>) : null);
      case PageNumberingStrategy.INCLUDE_ALL_PAGE:
        return (<View className="page-number">{(currentPage + 1) + ' / ' + imageUrls.length}</View>);
      case PageNumberingStrategy.EXCLUDE_COVER:
        return (currentPage > 0 ? (<View className="page-number">{(currentPage) + ' / ' + (imageUrls.length - 1)}</View>) : null);
      case PageNumberingStrategy.EXCLUDE_COVER_START_FROM_THIRD:
        return (currentPage > 0 ? (<View className="page-number">{(currentPage + 2) + ' / ' + (imageUrls.length + 1)}</View>) : null);
      default:
        return null;
    }
  };



  useEffect(() => {
  setImageUrls(concatImages[id])
  setCatalogList(catalogLists[id] || [])
  setAudioList(allAudioList[id])

  const deviceInfo = wx.getSystemInfo()
  deviceInfo.then((res) => {
    // 记录设备型号（原有逻辑）
    setSystemInfo(res.model)
  })

  // 循环播放（原有逻辑）
  audioContextRef.current.onEnded(() => {
    if (isLoopEnabled) {
      audioContextRef.current.play();
    } else {
      setIsAudioPlaying(false);
      setIsAudioPaused(false);
      // 取消保持屏幕常亮
      Taro.setKeepScreenOn({ keepScreenOn: false });
    }
  });

  return () => {
    audioContextRef.current.destroy()
  }
}, []);


  useEffect(() => {
  }, [currentPage])

  const handlePageTap = () => {
    setShowTopBar(!showTopBar);
    setShowBottomBar(!showBottomBar);
  };

  // 查看目录
  const handleCatalogShowingUp = () => {
    setCatalogVisible(true)
  };


  const handlePageTurning = (page) => {
    console.log("page: ", page)
    setCurrentPage(page)
  }

  // 新增：播放速度控制函数
  const changePlaybackRate = (rate: number) => {
    setPlaybackRate(rate);
    if (audioContextRef.current) {
      audioContextRef.current.playbackRate = rate;
    }
  };

  const playAudio = (url: string) => {
    // 如果当前已暂停，直接继续播放
    if (isAudioPaused) {
      audioContextRef.current.play();
      setIsAudioPlaying(true);
      setIsAudioPaused(false);
      // 保持屏幕常亮
      Taro.setKeepScreenOn({ keepScreenOn: true });
      return;
    }
    // 关闭之前播放的音频
    stopPlayingAudio();
    // IOS下无法播放音频问题
    Taro.setInnerAudioOption({ obeyMuteSwitch: false })
    audioContextRef.current.src = url
    audioContextRef.current.playbackRate = playbackRate; // 新增：设置播放速度
    audioContextRef.current.onPlay(() => {
      console.log('Start playback')
      // 保持屏幕常亮
      Taro.setKeepScreenOn({ keepScreenOn: true });
    })
    audioContextRef.current.onError((res) => {
      console.log('Audio play error:', res.errMsg);
      console.log('Error code:', res.errCode);
      switch (res.errCode) {
        case -1:
          console.log('网络错误，请检查网络连接');
          break;
        case -2:
          console.log('文件格式错误，请检查音频文件');
          break;
        case -3:
          console.log('解码错误，请检查音频文件');
          break;
        default:
          console.log('未知错误，请联系开发者');
      }
    });
    audioContextRef.current.play();
    setIsAudioPlaying(true);
    setIsAudioPaused(false);
    // 保持屏幕常亮
    Taro.setKeepScreenOn({ keepScreenOn: true });
  }

  const pausePlayingAudio = () => {
    audioContextRef.current.pause();
    setIsAudioPlaying(false);
    setIsAudioPaused(true);
  }

  const stopPlayingAudio = () => {
    audioContextRef.current.stop();
    setIsAudioPlaying(false);
    setIsAudioPaused(false);
    // 取消保持屏幕常亮
    Taro.setKeepScreenOn({ keepScreenOn: false });
  }
  // //插件
  // // 处理图片点击
  // const handleImageClick = (e) => {
  //   // 打印事件坐标
  //   console.log('点击事件 e.detail:', e.detail);
  //   // 获取图片实际显示区域
  //   Taro.createSelectorQuery()
  //     .select('.book-page')
  //     .boundingClientRect(rect => {
  //       console.log('图片 boundingClientRect:', rect);
  //     })
  //     .exec();
  //   clickTracker.handleImageClick(e, currentPage);
  // };
  // //插件
  // // 导出记录按钮逻辑
  // const exportRecords = () => {
  //   clickTracker.exportRecords();
  // };


  // 适配IPad端
  const containerClassName = !systemInfo.includes("iPad") ? "book-pages" : "book-pages book-page-ipad"
  const containerStyle = !systemInfo.includes("iPad") ?
    {
      height: "575px",
      marginBottom: "15px"
    } :
    {
      height: "100%",
      width: "75%",
      marginBottom: "30px"
    }

  // 拖拽事件处理
  const handlePanelTouchStart = (e) => {
    e.stopPropagation();
    if (e.preventDefault) e.preventDefault();
    const touch = e.touches[0];
    dragInfo.current.dragging = true;
    dragInfo.current.startX = touch.clientX;
    dragInfo.current.startY = touch.clientY;
    dragInfo.current.originLeft = panelPos.left;
    dragInfo.current.originTop = panelPos.top;
  };
  const handlePanelTouchMove = (e) => {
    e.stopPropagation();
    if (e.preventDefault) e.preventDefault();
    if (!dragInfo.current.dragging) return;
    const touch = e.touches[0];
    const deltaX = touch.clientX - dragInfo.current.startX;
    const deltaY = touch.clientY - dragInfo.current.startY;
    setPanelPos({
      left: Math.max(0, dragInfo.current.originLeft + deltaX),
      top: Math.max(0, dragInfo.current.originTop + deltaY)
    });
    return false;
  };
  const handlePanelTouchEnd = () => {
    dragInfo.current.dragging = false;
  };

  return (
    <View className="haisha-book-preview-container">

      {/* 顶栏 */}
      <View className={`top-bar ${showTopBar ? 'height' : 'none'}`}>
        {/* <View className="left-container" onClick={goBack}>
          <AtIcon value='chevron-left' size='25' />
          <Text className="back-button">
            返回
          </Text>
        </View> */}
        {/* <View className="right-container"> */}
        <View className={showTopBar ? '' : 'none'}>
          <Text className='title'>{titleMap[router.params?.id || '1'] || ''}</Text>
        </View>
      </View>

      {/* 书籍 */}
      <View className={containerClassName} onClick={handlePageTap}>
        <Swiper
          duration={300}
          current={currentPage}
          onChange={(e) => setCurrentPage(e.detail.current)}
          style={containerStyle}
          className="book-container"
          vertical
        // circular
        >
          {imageUrls.map((url, index) => (
            <SwiperItem key={index}>
              <View className="book-page-container">
                {
                  index === currentPage && ( // 只在当前页渲染按钮
                    <View className={`pause`} onClick={(e) => {
                      e.stopPropagation();
                      if (isAudioPlaying && !isAudioPaused) {
                        pausePlayingAudio();
                      } else if (isAudioPaused) {
                        playAudio(audioContextRef.current.src);
                      }
                    }}>
                      {
                        isAudioPlaying && !isAudioPaused ? (
                          <>
                            <AtIcon value='pause' color="red" size='14' />
                            <Text style={{ color: 'red' }}>播放中..</Text>
                          </>
                        ) : isAudioPaused ? (
                          <>
                            <AtIcon value='play' color="green" size='14' />
                            <Text style={{ color: 'green' }}>已暂停</Text>
                          </>
                        ) : null
                      }
                    </View>
                  )
                }
                {/* 合并：倍速+循环控制整体面板 */}
                {
                  index === currentPage && (isAudioPlaying || isAudioPaused) && (
                    <View
                      className="panel-drag-container"
                      catchMove
                      style={{
                        position: 'absolute',
                        left: panelPos.left,
                        top: panelPos.top,
                        zIndex: 999,
                        backgroundColor: 'rgba(255,255,255,0.75)',
                        borderRadius: '15px',
                        padding: '8px 12px',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.08)'
                      }}
                      onTouchStart={handlePanelTouchStart}
                      onTouchMove={handlePanelTouchMove}
                      onTouchEnd={handlePanelTouchEnd}
                    >
                      <View style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '6px' }}>
                        <Text style={{ fontSize: '12px', color: gray }}>倍速:</Text>
                        {[0.5, 0.75, 1.0, 1.25, 1.5, 2.0].map(rate => (
                          <Text
                            key={rate}
                            onClick={(e) => {
                              e.stopPropagation();
                              changePlaybackRate(rate);
                            }}
                            style={{
                              fontSize: '12px',
                              color: playbackRate === rate ? 'red' : gray,
                              fontWeight: playbackRate === rate ? 'bold' : 'normal',
                              padding: '2px 4px',
                              borderRadius: '3px',
                              backgroundColor: playbackRate === rate ? 'rgba(255, 0, 0, 0.1)' : 'transparent'
                            }}
                          >
                            {rate}x
                          </Text>
                        ))}
                      </View>
                      <View style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                        <Text style={{ fontSize: '12px', color: gray }}>循环:</Text>
                        <Text
                          onClick={(e) => {
                            e.stopPropagation();
                            setIsLoopEnabled(!isLoopEnabled);
                          }}
                          style={{
                            fontSize: '12px',
                            color: isLoopEnabled ? 'green' : gray,
                            fontWeight: isLoopEnabled ? 'bold' : 'normal',
                            padding: '2px 4px',
                            borderRadius: '3px',
                            backgroundColor: isLoopEnabled ? 'rgba(0, 255, 0, 0.1)' : 'transparent'
                          }}
                        >
                          {isLoopEnabled ? '开启' : '关闭'}
                        </Text>
                      </View>
                    </View>
                  )
                }
                {/* 插件——以下替换，其他恢复 */}
                <BookImage url={url} />
                {/* <BookImage url={url} onImageClick={handleImageClick} /> */}
                {/*注释，计算式 [(x - 653)/469, (y - 167)/606 */}
                <BookAudioTag audioList={audioList} currentPage={currentPage} playAudio={playAudio} />
              </View>
            </SwiperItem>
          ))}
        </Swiper>
      </View>

      {/*
        * 页码
        * 封面和目录页不需要展示页码，且页数需要减去封面和目录页
        * 调用函数
      */}
      {renderPageNumber()}


      {/* 底栏 */}
      <View className={`bottom-bar ${showTopBar ? 'height' : ''}`} onClick={handleCatalogShowingUp}>
        {/* <View className={`flex-container`} onClick={handleCatalogShowingUp}>
          <AtIcon className='menu' value='menu' size='20' color={gray} />
          <Text className="catalog-button">
            目录
          </Text>
        </View> */}
        <View className={`flex-container ${showTopBar ? '' : 'none'}`}>
          <AtIcon className='menu' value='menu' size='20' color={gray} />
          <Text className="catalog-button">
            目录
          </Text>
        </View>
        {/* <View className={`flex-container ${showTopBar ? '' : 'none'}`} onClick={handleAudioListShowingUp}>
          <AtIcon className='file-audio' value='file-audio' size='20' color={gray} />
          <Text className="audio-button">
            音频
          </Text>
        </View> */}
      </View>

      {/* 书籍目录 */}
      <AtFloatLayout
        isOpened={catalogVisible}
        title="目录"
        onClose={() => setCatalogVisible(false)}
        style={{ height: "800px" }}
      >
        {/* <View className="book-preview-catalog">
        </View> */}
        <AtList>
          {
            catalogList.map(({ name, page }) =>
              <AtListItem
                title={name}
                arrow='right'
                iconInfo={{ size: 15, value: 'list', color: green }}
                onClick={() => handlePageTurning(page)}
              />
            )
          }
        </AtList>
      </AtFloatLayout>

      {/* 插件 */}
      {/* <View onClick={exportRecords} style={{position:'fixed',bottom:10,right:10,zIndex:999,background:'#fff',padding:'8px',borderRadius:'8px'}}>导出点击记录</View> */}

    </View>
  );
};

export default BookPreview;



export const BookImage: React.FC<any> = React.memo(({ url, onImageClick }) => {
  return (
    <Image
      src={url}
      mode="widthFix"

      // //调试插件
      // onLoad={e => {
      //   const { width, height } = e.detail;
      //   console.log('图片原始像素：', width, height);
      // }}

      // 将图片自动转换为webp模式
      webp
      // 懒加载
      lazyLoad
      className="book-page"
      onClick={onImageClick}
      style={{ width: '100%' }}
    />
  )
})

export const BookAudioTag: React.FC<any> = React.memo(({ audioList, currentPage, playAudio, bookId }) => {
  // 临时加入封面页的坏办法，后续需要优化，原本没有bookId
  const getAudioPageIndex = () => {
    // OW系列（ID: 11-14）有封面页，需要调整偏移量
    if (bookId >= "11" && bookId <= "14") {
      return currentPage + 1; // 封面页后，音频数据索引需要+1
    }
    return currentPage + 2; // 其他书籍保持原有逻辑
  };

  return (
    <>
      {/* [(x - 653)/469, (y - 167)/606 */}
      {
        //加入数组判断，防止当audioList.ts中对象没有2[]这个属性时报错——无法正常显示页面
        Array.isArray(audioList[getAudioPageIndex()]) && audioList[getAudioPageIndex()].map((audio) => {
          const { offset = [], url, flag } = audio as any
          const [x = 0, y = 0] = offset

          let left = '0px';
          let top = '0px';
          switch (flag) {
            case 'Cambridge':
              left = decimalToPercentage((x - 3576) / 825);
              top = decimalToPercentage((y - 202) / 1061);
              break;
            case 'Percentage':
              left = x;
              top = y;
              break;
            default:
              left = decimalToPercentage((x - 653) / 469);
              top = decimalToPercentage((y - 167) / 606);
              break;
          }

          return <View
            className="float-rect"
            style={{
              position: 'absolute',
              left,
              top,
              width: "30px",
              height: "30px",
              // backgroundColor: "blue",
              // opacity: 0
            }}
            onClick={(e) => {
              e.stopPropagation();
              playAudio(url)
              // triggleAudioStatus(index, status)
            }}
          >
            <AtIcon value='volume-plus' color="red" size='25' />
            {/* <Image
          // style='width: 300px;height: 100px;background: #fff;'
          src='https://camo.githubusercontent.com/3e1b76e514b895760055987f164ce6c95935a3aa/687474703a2f2f73746f726167652e333630627579696d672e636f6d2f6d74642f686f6d652f6c6f676f2d3278313531333833373932363730372e706e67'
        /> */}
          </View>
        })
      }</>
  )
}
);
