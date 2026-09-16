
import React from "react";
import { AtTabBar } from "taro-ui";

export const BottomBar: React.FC = () => {
  return (
    <AtTabBar
      fixed
      current={1}
      onClick={() => { }}
      // color="rgb(80, 80, 80)"
      // color='rgb(67, 83, 108)'
      color="rgb(66, 134, 135)"
      backgroundColor="rgb(245, 245, 245)"
      tabList={[{ title: "书架", iconType: "folder" }]}
    />
  );
};
