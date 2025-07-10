import React, { useState, useEffect, useRef } from "react";
import Taro, { useRouter } from "@tarojs/taro";
import { AtFloatLayout, AtList, AtListItem, AtIcon } from "taro-ui"
import { Swiper, SwiperItem, Image, View, Text } from "@tarojs/components";
import { catalogLists } from "./constants/catalogList";
import { allAudioList } from "./constants/audioList";
import { concatImages } from "./constants/images";

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
  "1": '原版教材+剑桥考试课程',
  "2": '海沙国际课程',
  "3": 'CASA阅读启蒙&自然拼读 1',
  "4": 'CASA阅读启蒙&自然拼读 2',
  "5": 'CASA阅读启蒙&自然拼读 3',
  "6": 'CASA阅读启蒙&自然拼读 4',
  "7": '剑桥PET学生用书',
  "8": '剑桥PET练习册',
  "9": '剑桥KET学生用书',
  "10": '剑桥KET练习册',
  "11": 'Our World L1 学生用书',
  "12": 'Our World L1 练习册',
  "13": 'Our World Starter 学生用书',
  "14": 'Our World Starter 练习册',
  "15": 'Oxford Discover 1st edition',
  "16": 'Oxford Discover 2nd edition',
  "17": 'Oxford Discover 3rd edition',
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
}

// 定义一个新的类型枚举，来表示页码显示策略
enum PageNumberingStrategy {
  EXCLUDE_COVER_AND_TOC = "exclude_cover_and_toc",  // 不计入封面和目录页
  INCLUDE_ALL_PAGE = "include_all_page",            // 所有页都计入
  EXCLUDE_COVER = "exclude_cover",                  // 页码排除封面   //OW OD  系列从封面后一页开始计算
  //CUSTOM = "custom",                              // 自定义策略
}

const bookPageStrategyMap: Record<EBookType, PageNumberingStrategy> = {
  [EBookType.HAISHA_ADVERTISEMENT]: PageNumberingStrategy.INCLUDE_ALL_PAGE,
  [EBookType.HAISHA_INTRODUCTION]: PageNumberingStrategy.INCLUDE_ALL_PAGE,

  [EBookType.READING_BOOK_1]: PageNumberingStrategy.EXCLUDE_COVER_AND_TOC,
  [EBookType.READING_BOOK_2]: PageNumberingStrategy.EXCLUDE_COVER_AND_TOC,
  [EBookType.READING_BOOK_3]: PageNumberingStrategy.EXCLUDE_COVER_AND_TOC,
  [EBookType.READING_BOOK_4]: PageNumberingStrategy.EXCLUDE_COVER_AND_TOC,
  [EBookType.PET_STUDENT_BOOK_B1]: PageNumberingStrategy.EXCLUDE_COVER_AND_TOC,
  [EBookType.PET_PRACTICE_BOOK_B1]: PageNumberingStrategy.EXCLUDE_COVER_AND_TOC,
  [EBookType.KET_STUDENT_BOOK_A2]: PageNumberingStrategy.EXCLUDE_COVER_AND_TOC,
  [EBookType.KET_PRACTICE_BOOK_A2]: PageNumberingStrategy.EXCLUDE_COVER_AND_TOC,

  [EBookType.OW_STUDENT_BOOK_L1]: PageNumberingStrategy.EXCLUDE_COVER,
  [EBookType.OW_PRACTICE_BOOK_L1]: PageNumberingStrategy.EXCLUDE_COVER,
  [EBookType.OW_STUDENT_BOOK_STARTER]: PageNumberingStrategy.EXCLUDE_COVER,
  [EBookType.OW_PRACTICE_BOOK_STARTER]: PageNumberingStrategy.EXCLUDE_COVER,

  [EBookType.OD_DICSOVER_3RD_EDITION]: PageNumberingStrategy.EXCLUDE_COVER,
  [EBookType.OD_DICSOVER_1ST_EDITION]: PageNumberingStrategy.EXCLUDE_COVER,
  [EBookType.OD_DICSOVER_2ND_EDITION]: PageNumberingStrategy.EXCLUDE_COVER,
}

const BookPreview: React.FC<IBookPreviewProps> = ({ id = "1", currentPage, setCurrentPage }) => {
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [catalogList, setCatalogList] = useState([])
  const [audioList, setAudioList] = useState({})
  const [showTopBar, setShowTopBar] = useState(false);
  const [showBottomBar, setShowBottomBar] = useState(false);
  const [catalogVisible, setCatalogVisible] = useState(false);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false); // 当前是否有音频正在播放
  const audioContextRef = useRef<Taro.InnerAudioContext>(Taro.createInnerAudioContext())
  const router = useRouter();

  const renderPageNumber = () => {
    switch (bookPageStrategyMap[id]) {
      case PageNumberingStrategy.EXCLUDE_COVER_AND_TOC:
        return (currentPage > 1 ? (<View className="page-number">{(currentPage - 1) + ' / ' + (imageUrls.length - 2)}</View>) : null);
      case PageNumberingStrategy.INCLUDE_ALL_PAGE:
        return (<View className="page-number">{(currentPage + 1) + ' / ' + imageUrls.length}</View>);
      case PageNumberingStrategy.EXCLUDE_COVER:
        return (currentPage > 0 ? (<View className="page-number">{(currentPage) + ' / ' + (imageUrls.length - 1)}</View>) : null);
      default:
        return null;
    }
  };

  useEffect(() => {
    setImageUrls(concatImages[id])
    setCatalogList(catalogLists[id] || [])
    setAudioList(allAudioList[id])

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

  const goBack = () => {
    Taro.navigateBack({ delta: 1 });
  };

  // 查看目录
  const handleCatalogShowingUp = () => {
    setCatalogVisible(true)
  };


  const handlePageTurning = (page) => {
    console.log("page: ", page)
    setCurrentPage(page)
  }

  const playAudio = (url: string) => {
    // 关闭之前播放的音频
    stopPlayingAudio();
    // IOS下无法播放音频问题
    Taro.setInnerAudioOption({ obeyMuteSwitch: false })
    audioContextRef.current.src = url
    audioContextRef.current.onPlay(() => {
      console.log('Start playback')
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
  }

  const stopPlayingAudio = () => {
    audioContextRef.current.stop()
    setIsAudioPlaying(false)
  }

  return (
    <View className="haisha-book-preview-container">

      {/* 顶栏 */}
      <View className={`top-bar ${showTopBar ? 'height' : ''}`}>
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
      <View className="book-pages" onClick={handlePageTap}>
        <Swiper
          duration={300}
          current={currentPage}
          onChange={(e) => setCurrentPage(e.detail.current)}
          style={{ height: "575px", marginBottom: "15px" }}
          className="book-container"
          vertical
        // circular
        >
          {imageUrls.map((url, index) => (
            <SwiperItem key={index}>
              <View className="book-page-container">
                {
                  <View className={`pause ${isAudioPlaying ? '' : 'hide'}`} onClick={() => stopPlayingAudio()}>
                    <AtIcon value='pause' color="red" size='20' />
                    <Text style={{ color: 'red' }}>播放中..</Text>
                  </View>
                }
                <BookImage url={url} />
                {/* [(x - 653)/469, (y - 167)/606 */}
                <BookAudioTag audioList={audioList} currentPage={currentPage} playAudio={playAudio} bookId={id} />
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

    </View>
  );
};

export default BookPreview;



export const BookImage: React.FC<any> = React.memo(({ url }) => {
  return (
      <Image src={url} mode="widthFix" className="book-page" />
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
