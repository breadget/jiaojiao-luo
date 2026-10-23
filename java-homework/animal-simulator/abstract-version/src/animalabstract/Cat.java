package animalabstract;

/** 继承抽象类 Animal 的猫类，必须重写全部抽象方法 */
public class Cat extends Animal {
    @Override
    public void cry() {
        System.out.println("喵喵喵！");
    }

    @Override
    public String getAnimalName() {
        return "猫";
    }
}
