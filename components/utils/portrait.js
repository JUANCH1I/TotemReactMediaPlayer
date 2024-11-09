import { Dimensions } from 'react-native'
const { width, height } = Dimensions.get('screen')
const widthScreen = width
const heightScreen = height
export { widthScreen, heightScreen }

export const isPortrait = () => height > width
