import React from "react";
import { View, Text, Image } from "@tarojs/components";
import { images } from "./constant";
import "./BookShelf.scss";

const titleMap = {
  1:  '原版教材+剑桥考试课程',
  2:  '海沙国际课程',
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
  15: 'Oxford Discover 1 edition',
  16: 'Oxford Discover 2 edition',
  17: 'Oxford Discover 3 edition',
}

export const BookShelf: React.FC = () => {

  const navigateToBookDetail = (bookIndex) => {
    wx.navigateTo({
      url: "/pages/BookDetail/BookDetail" + "?id=" + (bookIndex + 1),
      events: {
        // 为指定事件添加一个监听器，获取被打开页面传送到当前页面的数据
        acceptDataFromOpenedPage: function (data) {
          console.log(data);
        },
        someEvent: function (data) {
          console.log(data);
        },
      },
      success: function (res) {
        console.log("success");
        // 通过eventChannel向被打开页面传送数据
        res.eventChannel.emit("acceptDataFromOpenerPage", { data: bookIndex });
      },
    });

    // wx.previewImage({
    //   current: images[0], // 当前显示图片的http链接
    //   urls: images, // 需要预览的图片http链接列表
    // });
  };

  return (

    <View className="haisha-bookshelf">
      {images.map((image, index) => (
        <View className="book-item" onClick={() => navigateToBookDetail(index)}>
          <Image className="cover" src={image} mode="aspectFill" />
          <Text className="text">{titleMap[index + 1]}</Text>
        </View>
      ))}
    </View>
  );
};
